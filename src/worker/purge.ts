import type { Hono } from 'hono';
import { HttpError, type Principal, audit, can, isAdmin } from './auth';
import type { Env } from './util';

type App = Hono<{ Bindings: Env; Variables: { principal: Principal } }>;

export const KEEP_DAYS = 30;

/** Remove conversations for good: their rows, their search entries, and their files in R2. */
export async function purgeThreads(env: Env, ids: string[]): Promise<number> {
  let removed = 0;
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    const marks = chunk.map(() => '?').join(',');
    const keys = await env.DB.prepare(
      `SELECT raw_key AS k FROM message WHERE thread_id IN (${marks}) AND raw_key IS NOT NULL
       UNION ALL SELECT a.r2_key AS k FROM attachment a JOIN message m ON m.id = a.message_id WHERE m.thread_id IN (${marks})`,
    ).bind(...chunk, ...chunk).all<{ k: string }>();
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM message_fts WHERE rowid IN (SELECT rowid FROM message WHERE thread_id IN (${marks}))`).bind(...chunk),
      env.DB.prepare(`DELETE FROM attachment WHERE message_id IN (SELECT id FROM message WHERE thread_id IN (${marks}))`).bind(...chunk),
      env.DB.prepare(`DELETE FROM message_event WHERE message_id IN (SELECT id FROM message WHERE thread_id IN (${marks}))`).bind(...chunk),
      env.DB.prepare(`DELETE FROM message WHERE thread_id IN (${marks})`).bind(...chunk),
      env.DB.prepare(`DELETE FROM thread_label WHERE thread_id IN (${marks})`).bind(...chunk),
      env.DB.prepare(`DELETE FROM ai_brief WHERE thread_id IN (${marks})`).bind(...chunk),
      env.DB.prepare(`UPDATE agent_run SET thread_id = NULL WHERE thread_id IN (${marks})`).bind(...chunk),
      env.DB.prepare(`DELETE FROM thread WHERE id IN (${marks})`).bind(...chunk),
    ]);
    // Files go last: if this fails the rows are already gone and only unreferenced files remain.
    for (let k = 0; k < keys.results.length; k += 500) await env.MAIL.delete(keys.results.slice(k, k + 500).map((r) => r.k));
    removed += chunk.length;
  }
  return removed;
}

/** Spam and Trash empty themselves: anything there longer than 30 days is removed for good. */
export async function purgeOld(env: Env, now: number = Date.now()): Promise<number> {
  const old = await env.DB.prepare("SELECT id FROM thread WHERE folder IN ('spam', 'trash') AND COALESCE(moved_at, last_at) < ? LIMIT 200").bind(now - KEEP_DAYS * 86_400_000).all<{ id: string }>();
  return old.results.length ? purgeThreads(env, old.results.map((r) => r.id)) : 0;
}

const KEEP_CHOICES = [0, 7, 30, 90];

export async function activityKeepDays(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT value FROM setting WHERE key = 'activity_keep_days'").first<{ value: string }>();
  const n = Number(row?.value ?? 30);
  return KEEP_CHOICES.includes(n) ? n : 30;
}

/** Delete activity history older than the chosen number of days. Mail itself is never touched. */
export async function purgeActivity(env: Env, now: number = Date.now()): Promise<number> {
  const days = await activityKeepDays(env);
  if (days === 0) return 0;
  const cutoff = now - days * 86_400_000;
  const done = await env.DB.batch([
    env.DB.prepare('DELETE FROM message_event WHERE at < ?').bind(cutoff),
    env.DB.prepare('DELETE FROM agent_run WHERE at < ?').bind(cutoff),
    env.DB.prepare('DELETE FROM audit WHERE at < ?').bind(cutoff),
  ]);
  return done.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}

export function registerPurge(api: App): void {
  /** Mail activity, newest first, ten to a page, within the kept period. */
  api.get('/activity', async (c) => {
    const p = c.var.principal;
    if (!isAdmin(p)) throw new HttpError(403, 'forbidden', 'Only an owner or admin can see mail activity.');
    const keepDays = await activityKeepDays(c.env);
    const since = keepDays === 0 ? 0 : Date.now() - keepDays * 86_400_000;
    const size = 10;
    const total = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM message WHERE status != 'draft' AND at >= ?").bind(since).first<{ n: number }>())?.n ?? 0;
    const pages = Math.max(1, Math.ceil(total / size));
    const page = Math.min(pages, Math.max(1, Number(c.req.query('page')) || 1));
    const rows = await c.env.DB.prepare(
      `SELECT m.id, m.at, m.direction, m.from_email, m.to_json, m.status, (SELECT SUM(e.ms) FROM message_event e WHERE e.message_id = m.id) AS ms
         FROM message m WHERE m.status != 'draft' AND m.at >= ? ORDER BY m.at DESC, m.id DESC LIMIT ? OFFSET ?`,
    ).bind(since, size, (page - 1) * size).all<{ id: string; at: number; direction: 'in' | 'out'; from_email: string; to_json: string; status: string; ms: number | null }>();
    return c.json({
      data: rows.results.map((r) => ({ id: r.id, at: r.at, direction: r.direction, from: r.from_email, to: (JSON.parse(r.to_json) as { email: string }[]).map((x) => x.email).join(', '), status: r.status, ms: r.ms })),
      total, page, pages, keepDays,
    });
  });

  /** AI activity, newest first, ten to a page. */
  api.get('/ai/runs', async (c) => {
    const p = c.var.principal;
    if (!isAdmin(p)) throw new HttpError(403, 'forbidden', 'Only an owner or admin can see AI activity.');
    const total = (await c.env.DB.prepare('SELECT COUNT(*) AS n FROM agent_run WHERE hidden = 0').first<{ n: number }>())?.n ?? 0;
    const pages = Math.max(1, Math.ceil(total / 10));
    const page = Math.min(Math.max(Number(c.req.query('page')) || 1, 1), pages);
    const rows = await c.env.DB.prepare(
      `SELECT r.id, r.at, r.kind, a.name AS agent, r.status, r.provider, r.model, r.ms, r.tokens_in AS tokensIn, r.tokens_out AS tokensOut, r.error
         FROM agent_run r LEFT JOIN agent a ON a.id = r.agent_id WHERE r.hidden = 0 ORDER BY r.at DESC LIMIT 10 OFFSET ?`,
    ).bind((page - 1) * 10).all();
    return c.json({ data: rows.results, total, page, pages, keepDays: await activityKeepDays(c.env) });
  });

  // Deleting a record: older ones are removed; today's are hidden, because they count toward the daily limit.
  const dropRuns = async (env: Env, id: string | null) => {
    const start = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    const only = id ? ' AND id = ?' : '';
    const args = id ? [id] : [];
    const done = await env.DB.batch([
      env.DB.prepare(`UPDATE agent_run SET hidden = 1 WHERE hidden = 0 AND at >= ?${only}`).bind(start, ...args),
      env.DB.prepare(`DELETE FROM agent_run WHERE at < ?${only}`).bind(start, ...args),
    ]);
    return done.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
  };

  api.delete('/ai/runs', async (c) => {
    const p = c.var.principal;
    if (!isAdmin(p)) throw new HttpError(403, 'forbidden', 'Only an owner or admin can delete AI activity.');
    const removed = await dropRuns(c.env, null);
    await audit(c.env, p, 'ai.runs.clear', '', String(removed));
    return c.json({ removed });
  });

  api.delete('/ai/runs/:id', async (c) => {
    const p = c.var.principal;
    if (!isAdmin(p)) throw new HttpError(403, 'forbidden', 'Only an owner or admin can delete AI activity.');
    if (!(await dropRuns(c.env, c.req.param('id')))) throw new HttpError(404, 'not_found', 'That record is already gone.');
    return c.json({ ok: true });
  });

  api.patch('/settings', async (c) => {
    const p = c.var.principal;
    if (!isAdmin(p)) throw new HttpError(403, 'forbidden', 'Only an owner or admin can change settings.');
    const body = await c.req.json<{ activityKeepDays?: number }>().catch(() => ({}) as { activityKeepDays?: number });
    if (!KEEP_CHOICES.includes(body.activityKeepDays as number)) throw new HttpError(422, 'bad_value', 'Choose 7, 30 or 90 days, or keep for ever.');
    await c.env.DB.prepare("INSERT INTO setting (key, value) VALUES ('activity_keep_days', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(body.activityKeepDays)).run();
    await audit(c.env, p, 'settings.activity_keep_days', '', String(body.activityKeepDays));
    const removed = await purgeActivity(c.env);
    return c.json({ activityKeepDays: body.activityKeepDays, removed });
  });

  api.post('/threads/:id/delete-forever', async (c) => {
    const p = c.var.principal;
    const thread = await c.env.DB.prepare('SELECT id, mailbox_id, folder, subject FROM thread WHERE id = ?').bind(c.req.param('id')).first<{ id: string; mailbox_id: string; folder: string; subject: string }>();
    if (!thread || !can(p, thread.mailbox_id, 'read')) throw new HttpError(404, 'not_found', 'Conversation not found.');
    if (!can(p, thread.mailbox_id, 'delete')) throw new HttpError(403, 'forbidden', 'You do not have permission to delete in this mailbox.');
    if (thread.folder !== 'trash' && thread.folder !== 'spam') throw new HttpError(409, 'not_in_trash', 'Move the conversation to Trash first.');
    await purgeThreads(c.env, [thread.id]);
    await audit(c.env, p, 'thread.delete_forever', thread.id, thread.subject);
    return c.json({ ok: true });
  });

  /** Empty Trash or Spam, in one mailbox or in every mailbox the person may delete in. */
  api.post('/folders/:folder/empty', async (c) => {
    const p = c.var.principal;
    const folder = c.req.param('folder');
    if (folder !== 'trash' && folder !== 'spam') throw new HttpError(400, 'bad_folder', 'Only Trash and Spam can be emptied.');
    const mailbox = c.req.query('mailbox');
    const rows = await c.env.DB.prepare(`SELECT id, mailbox_id FROM thread WHERE folder = ?${mailbox ? ' AND mailbox_id = ?' : ''} LIMIT 1000`).bind(folder, ...(mailbox ? [mailbox] : [])).all<{ id: string; mailbox_id: string }>();
    const mine = rows.results.filter((r) => isAdmin(p) || can(p, r.mailbox_id, 'delete')).map((r) => r.id);
    const removed = await purgeThreads(c.env, mine);
    await audit(c.env, p, `folder.empty.${folder}`, mailbox ?? 'all', String(removed));
    return c.json({ removed, more: rows.results.length === 1000 });
  });
}
