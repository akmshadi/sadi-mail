import { Hono } from 'hono';
import type {
  AgentInfo, AgentNote, AiOverview, ProviderInfo, ThreadAi,
  AddressInfo, AttachmentInfo, Bootstrap, MailboxInfo, MessageDetail, MessageEvent, Person, Role, SendRequest, SystemStatus, ThreadDetail, ThreadSummary, View,
} from '../shared/types';
import { HttpError, type Principal, assertCan, audit, authenticate, can, isAdmin, mailboxScope } from './auth';
import { DEFAULT_MODELS, type ProviderKind, activeProviders, callsToday, complete, logRun, sealKey } from './ai';
import { buildBrief, draftReply, draftReplyStream, getBrief, listAgents, rewrite, rewriteStream, runCustom, writeNew, writeNewStream } from './assistant';
import { registerExtras } from './extras';
import { registerPurge } from './purge';
import { registerBulk } from './bulk';
import { registerMedia } from './media';
import { parseLetterhead } from '../shared/design';
import { registerServers } from './servers';
import { parseProfile, profileForAi } from '../shared/profile';
import { SECTIONS, isSection } from './section';
import { parseSignature, signatureHtml, signatureText } from '../shared/signature';
import { registerImport } from './importer';
import { registerRules } from './rules';
import { cleanHtml } from './sanitize';
import { deliverDue, sendMessage } from './send';
import { type Env, ftsQuery, newId, normaliseEmail } from './util';

type App = { Bindings: Env; Variables: { principal: Principal } };

export const api = new Hono<App>().basePath('/api');

api.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.code, message: err.message }, err.status);
  console.error(JSON.stringify({ at: 'api', path: new URL(c.req.url).pathname, error: err instanceof Error ? err.message : String(err) }));
  return c.json({ error: 'internal', message: 'Something went wrong on the server.' }, 500);
});

api.use('*', async (c, next) => {
  c.set('principal', await authenticate(c.env, c.req.raw));
  await next();
  // Streamed answers set their own value (no-store, no-transform); everything else is simply never cached.
  if (!c.res.headers.get('Cache-Control')?.includes('no-transform')) c.header('Cache-Control', 'no-store');
});

// ---------- rows → wire ----------

interface ThreadRow {
  id: string; mailbox_id: string; address_id: string; address_email: string; subject: string; folder: ThreadSummary['folder']; last_at: number;
  last_from_name: string; last_from_email: string; snippet: string; message_count: number; unread_count: number; has_attachment: number;
  starred: number; flagged_auth: number; is_bulk: number; ai_category: string | null; ai_priority: number; follow_up: number; snoozed_until: number | null; labels: string | null; section: string; files: string | null; file_count: number; last_direction: string | null;
}

const THREAD_COLUMNS = `t.id, t.mailbox_id, t.address_id, a.email AS address_email, t.subject, t.folder, t.last_at, t.last_from_name, t.last_from_email,
  t.snippet, t.message_count, t.unread_count, t.has_attachment, t.starred, t.flagged_auth, t.is_bulk, t.ai_category, t.ai_priority, t.follow_up, t.snoozed_until, t.section,
  (SELECT json_group_array(filename) FROM (SELECT a.filename FROM attachment a JOIN message am ON am.id = a.message_id WHERE am.thread_id = t.id AND a.inline = 0 AND am.status != 'draft' ORDER BY am.at DESC, a.id LIMIT 3)) AS files,
  (SELECT COUNT(*) FROM attachment a JOIN message am ON am.id = a.message_id WHERE am.thread_id = t.id AND a.inline = 0 AND am.status != 'draft') AS file_count,
  (SELECT json_group_array(json_object('id', l.id, 'name', l.name, 'color', l.color)) FROM thread_label tl JOIN label l ON l.id = tl.label_id WHERE tl.thread_id = t.id) AS labels,
  (SELECT direction FROM message m WHERE m.thread_id = t.id ORDER BY m.at DESC LIMIT 1) AS last_direction`;

function toSummary(r: ThreadRow): ThreadSummary {
  return {
    id: r.id, mailboxId: r.mailbox_id, addressId: r.address_id, addressEmail: r.address_email, subject: r.subject, folder: r.folder, lastAt: r.last_at,
    fromName: r.last_from_name, fromEmail: r.last_from_email, snippet: r.snippet, messageCount: r.message_count, unread: r.unread_count > 0,
    starred: !!r.starred, hasAttachment: !!r.has_attachment, flaggedAuth: !!r.flagged_auth,
    needsReply: r.last_direction === 'in' && !r.flagged_auth && !r.is_bulk && r.folder === 'inbox',
    priority: !!r.ai_priority, category: r.ai_category, followUp: !!r.follow_up,
    section: (isSection(r.section) ? r.section : 'primary'),
    files: r.files ? (JSON.parse(r.files) as string[]) : [], fileCount: r.file_count ?? 0,
    labels: r.labels ? (JSON.parse(r.labels) as ThreadSummary['labels']) : [], snoozedUntil: r.snoozed_until && r.snoozed_until > Date.now() ? r.snoozed_until : null,
  };
}

function viewFilter(view: View, now: number): { sql: string; params: number[] } {
  switch (view) {
    case 'inbox': return { sql: "t.folder = 'inbox' AND t.has_inbound = 1 AND (t.snoozed_until IS NULL OR t.snoozed_until <= ?)", params: [now] };
    case 'unread': return { sql: "t.folder = 'inbox' AND t.unread_count > 0", params: [] };
    case 'snoozed': return { sql: "t.snoozed_until > ? AND t.folder = 'inbox'", params: [now] };
    case 'starred': return { sql: "t.starred = 1 AND t.folder NOT IN ('trash', 'spam') AND (t.has_inbound = 1 OR t.has_outbound = 1)", params: [] };
    case 'sent': return { sql: "t.has_outbound = 1 AND t.folder != 'trash' AND EXISTS (SELECT 1 FROM message m WHERE m.thread_id = t.id AND m.direction = 'out' AND m.status IN ('sent', 'dry_run', 'failed'))", params: [] };
    case 'scheduled': return { sql: "EXISTS (SELECT 1 FROM message m WHERE m.thread_id = t.id AND m.status = 'scheduled')", params: [] };
    case 'drafts': return { sql: "EXISTS (SELECT 1 FROM message m WHERE m.thread_id = t.id AND m.status = 'draft')", params: [] };
    case 'archive': case 'spam': case 'trash': return { sql: `t.folder = '${view}' AND (t.has_inbound = 1 OR t.has_outbound = 1)`, params: [] };
    default: throw new HttpError(400, 'bad_view', 'Unknown view.');
  }
}

const VIEWS: View[] = ['inbox', 'unread', 'starred', 'snoozed', 'sent', 'scheduled', 'drafts', 'archive', 'spam', 'trash'];

// ---------- bootstrap ----------

api.get('/bootstrap', async (c) => {
  const p = c.var.principal;
  const db = c.env.DB;
  const [mailboxes, addresses, unread, totals, providers] = await db.batch([
    db.prepare('SELECT id, name, color, letterhead_json FROM mailbox ORDER BY position, created_at'),
    db.prepare('SELECT id, mailbox_id, email, display_name, signature, signature_html, signature_json, is_default, discovered FROM address ORDER BY is_default DESC, email'),
    db.prepare("SELECT mailbox_id, COUNT(*) AS n FROM thread WHERE folder = 'inbox' AND unread_count > 0 GROUP BY mailbox_id"),
    db.prepare("SELECT COUNT(*) AS messages, COALESCE(SUM(size), 0) AS bytes, MAX(CASE WHEN direction = 'in' THEN at END) AS last_in FROM message"),
    db.prepare('SELECT COUNT(*) AS n FROM ai_provider WHERE enabled = 1'),
  ]);
  const unreadBy = new Map((unread!.results as { mailbox_id: string; n: number }[]).map((r) => [r.mailbox_id, r.n]));
  const letter = (json: string | null) => { try { return parseLetterhead(JSON.parse(json || 'null')); } catch { return parseLetterhead(null); } };
  const list: MailboxInfo[] = (mailboxes!.results as { id: string; name: string; color: string; letterhead_json: string | null }[])
    .filter((m) => can(p, m.id, 'read'))
    .map((m) => ({
      id: m.id, name: m.name, color: m.color, letterhead: letter(m.letterhead_json), unread: unreadBy.get(m.id) ?? 0,
      addresses: (addresses!.results as { id: string; mailbox_id: string; email: string; display_name: string; signature: string; signature_html: string | null; signature_json: string | null; is_default: number; discovered: number }[])
        .filter((a) => a.mailbox_id === m.id)
        .map((a): AddressInfo => ({ id: a.id, mailboxId: a.mailbox_id, email: a.email, displayName: a.display_name, signature: a.signature, signatureHtml: a.signature_html ?? '', signatureFields: a.signature_json ? parseSignature(JSON.parse(a.signature_json)) : null, isDefault: !!a.is_default, discovered: !!a.discovered })),
      can: { send: can(p, m.id, 'send'), edit: can(p, m.id, 'edit'), delete: can(p, m.id, 'delete') },
    }));
  const t = totals!.results[0] as { messages: number; bytes: number; last_in: number | null };
  const body: Bootstrap = {
    user: { id: p.userId, name: p.name, role: p.role, hasAvatar: !!(await db.prepare('SELECT avatar_key FROM user WHERE id = ?').bind(p.userId).first<{ avatar_key: string | null }>())?.avatar_key },
    mailboxes: list,
    sendMode: c.env.SEND_MODE === 'cloudflare' ? 'cloudflare' : 'dry-run',
    serverSenders: (await db.prepare("SELECT email FROM mail_server WHERE send_enabled = 1 AND smtp_host <> ''").all<{ email: string }>().catch(() => ({ results: [] as { email: string }[] }))).results.map((r) => r.email),
    ai: { connected: (await activeProviders(c.env)).length > 0 },
    storage: { messages: t.messages, bytes: t.bytes, lastReceivedAt: t.last_in },
  };
  return c.json(body);
});

// ---------- threads ----------

api.get('/threads', async (c) => {
  const p = c.var.principal;
  const view = (c.req.query('view') ?? 'inbox') as View;
  if (!VIEWS.includes(view)) throw new HttpError(400, 'bad_view', 'Unknown view.');
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 100);
  const filter = viewFilter(view, Date.now());
  const scope = mailboxScope(p, 't.mailbox_id');
  const where = [filter.sql];
  const params: (string | number)[] = [...filter.params];

  const mailbox = c.req.query('mailbox');
  if (mailbox) { where.push('t.mailbox_id = ?'); params.push(mailbox); }
  const address = c.req.query('address');
  if (address) { where.push('t.address_id = ?'); params.push(address); }
  const section = c.req.query('section');
  if (section && view === 'inbox') {
    if (!isSection(section)) throw new HttpError(400, 'bad_section', 'Unknown inbox section.');
    where.push('t.section = ?');
    params.push(section);
  }
  const label = c.req.query('label');
  if (label) { where.push('EXISTS (SELECT 1 FROM thread_label tl WHERE tl.thread_id = t.id AND tl.label_id = ?)'); params.push(label); }
  // Advanced filters: a time range on the latest message, the sender, and attachments.
  const after = Number(c.req.query('after'));
  if (Number.isFinite(after) && after > 0) { where.push('t.last_at >= ?'); params.push(after); }
  const before = Number(c.req.query('before'));
  if (Number.isFinite(before) && before > 0) { where.push('t.last_at < ?'); params.push(before); }
  const sender = (c.req.query('from') ?? '').trim().toLowerCase().slice(0, 120);
  if (sender) {
    const like = `%${sender.replace(/[\\%_]/g, '\\$&')}%`;
    where.push("(LOWER(t.last_from_email) LIKE ? ESCAPE '\\' OR LOWER(t.last_from_name) LIKE ? ESCAPE '\\')");
    params.push(like, like);
  }
  if (c.req.query('files') === '1') where.push('t.has_attachment = 1');
  const cursor = c.req.query('cursor');
  if (cursor) {
    const [at, id] = cursor.split('_');
    where.push('(t.last_at < ? OR (t.last_at = ? AND t.id < ?))');
    params.push(Number(at), Number(at), id ?? '');
  }

  const rows = await c.env.DB.prepare(
    `SELECT ${THREAD_COLUMNS} FROM thread t JOIN address a ON a.id = t.address_id
      WHERE ${where.join(' AND ')}${scope.sql} ORDER BY t.last_at DESC, t.id DESC LIMIT ?`,
  ).bind(...params, ...scope.params, limit + 1).all<ThreadRow>();
  const page = rows.results.slice(0, limit);
  const last = page[page.length - 1];
  return c.json({ data: page.map(toSummary), nextCursor: rows.results.length > limit && last ? `${last.last_at}_${last.id}` : null });
});

api.get('/counts', async (c) => {
  const p = c.var.principal;
  const scope = mailboxScope(p, 't.mailbox_id');
  const mailbox = c.req.query('mailbox');
  const extra = mailbox ? ' AND t.mailbox_id = ?' : '';
  const params = [...(mailbox ? [mailbox] : []), ...scope.params];
  const row = await c.env.DB.prepare(
    `SELECT
       SUM(CASE WHEN t.folder = 'inbox' AND t.has_inbound = 1 AND t.unread_count > 0 THEN 1 ELSE 0 END) AS inbox,
       SUM(CASE WHEN t.folder = 'spam' THEN 1 ELSE 0 END) AS spam,
       SUM(CASE WHEN EXISTS (SELECT 1 FROM message m WHERE m.thread_id = t.id AND m.status = 'scheduled') THEN 1 ELSE 0 END) AS scheduled
     FROM thread t WHERE 1 = 1${extra}${scope.sql}`,
  ).bind(...params).first<{ inbox: number | null; spam: number | null; scheduled: number | null }>();
  // Unread conversations in each inbox section, for the section tabs.
  const bySection = await c.env.DB.prepare(
    `SELECT t.section, COUNT(*) AS n FROM thread t WHERE t.folder = 'inbox' AND t.has_inbound = 1 AND t.unread_count > 0${extra}${scope.sql} GROUP BY t.section`,
  ).bind(...params).all<{ section: string; n: number }>();
  const sections = Object.fromEntries(SECTIONS.map((s) => [s, 0])) as Record<(typeof SECTIONS)[number], number>;
  for (const r of bySection.results) if (isSection(r.section)) sections[r.section] = r.n;
  return c.json({ inbox: row?.inbox ?? 0, spam: row?.spam ?? 0, scheduled: row?.scheduled ?? 0, sections });
});

async function loadThread(env: Env, p: Principal, id: string): Promise<ThreadRow> {
  const row = await env.DB.prepare(`SELECT ${THREAD_COLUMNS} FROM thread t JOIN address a ON a.id = t.address_id WHERE t.id = ?`).bind(id).first<ThreadRow>();
  if (!row || !can(p, row.mailbox_id, 'read')) throw new HttpError(404, 'not_found', 'Conversation not found.');
  return row;
}

api.get('/threads/:id', async (c) => {
  const p = c.var.principal;
  const db = c.env.DB;
  const row = await loadThread(c.env, p, c.req.param('id'));
  const loadImages = c.req.query('images') === '1';

  const [messages, attachments, events, earlier] = await db.batch([
    db.prepare('SELECT * FROM message WHERE thread_id = ? ORDER BY at, id').bind(row.id),
    db.prepare('SELECT a.id, a.message_id, a.filename, a.mime, a.size, a.inline FROM attachment a JOIN message m ON m.id = a.message_id WHERE m.thread_id = ?').bind(row.id),
    db.prepare('SELECT e.message_id, e.kind, e.detail, e.at, e.ms FROM message_event e JOIN message m ON m.id = e.message_id WHERE m.thread_id = ? ORDER BY e.at, e.id').bind(row.id),
    db.prepare(
      `SELECT t.id, t.subject, t.last_at FROM thread t WHERE t.mailbox_id = ? AND t.id != ? AND t.folder NOT IN ('trash', 'spam')
         AND EXISTS (SELECT 1 FROM message m WHERE m.thread_id = t.id AND m.from_email = ?) ORDER BY t.last_at DESC LIMIT 5`,
    ).bind(row.mailbox_id, row.id, row.last_from_email),
  ]);

  const detail: MessageDetail[] = [];
  for (const m of messages!.results as Record<string, unknown>[]) {
    let inline: Map<string, string> | undefined;
    if (typeof m.body_html === 'string' && /cid:/i.test(m.body_html)) {
      // Pictures embedded in the message are handed to the page as data, so they show in every sign-in mode.
      inline = new Map();
      const pics = await db.prepare("SELECT content_id, mime, r2_key, size FROM attachment WHERE message_id = ? AND content_id IS NOT NULL AND size <= 1500000 AND mime IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp') LIMIT 12").bind(m.id).all<{ content_id: string; mime: string; r2_key: string; size: number }>();
      for (const pic of pics.results) {
        const object = await c.env.MAIL.get(pic.r2_key);
        if (!object) continue;
        const bytes = new Uint8Array(await object.arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        inline.set(pic.content_id.replace(/^<|>$/g, '').toLowerCase(), `data:${pic.mime};base64,${btoa(binary)}`);
      }
    }
    const cleaned = typeof m.body_html === 'string' ? await cleanHtml(m.body_html, { loadImages, inline }) : null;
    detail.push({
      id: m.id as string,
      direction: m.direction as 'in' | 'out',
      status: m.status as MessageDetail['status'],
      from: { name: m.from_name as string, email: m.from_email as string },
      to: JSON.parse(m.to_json as string) as Person[],
      cc: (JSON.parse(m.cc_json as string) as Person[]),
      subject: m.subject as string,
      at: m.at as number,
      scheduledFor: (m.scheduled_for as number | null) ?? null,
      text: m.body_text as string,
      html: cleaned?.html ?? null,
      hasRemoteImages: cleaned?.hasRemoteImages ?? false,
      truncated: !!m.body_truncated,
      auth: { spf: m.spf as MessageDetail['auth']['spf'], dkim: m.dkim as MessageDetail['auth']['dkim'], dmarc: m.dmarc as MessageDetail['auth']['dmarc'] },
      attachments: (attachments!.results as (AttachmentInfo & { message_id: string })[])
        .filter((a) => a.message_id === m.id)
        .map((a) => ({ id: a.id, filename: a.filename, mime: a.mime, size: a.size, inline: !!a.inline })),
      events: (events!.results as (MessageEvent & { message_id: string })[]).filter((e) => e.message_id === m.id).map((e) => ({ kind: e.kind, detail: e.detail, at: e.at, ms: e.ms })),
      error: (m.error as string | null) ?? null,
    });
  }

  const body: ThreadDetail = {
    ...toSummary(row),
    messages: detail,
    replyFrom: row.address_id,
    earlier: (earlier!.results as { id: string; subject: string; last_at: number }[]).map((e) => ({ id: e.id, subject: e.subject, at: e.last_at })),
  };
  return c.json(body);
});

const THREAD_ACTIONS = {
  read: { sql: 'unread_count = 0', needs: 'edit' },
  unread: { sql: 'unread_count = MAX(unread_count, 1)', needs: 'edit' },
  star: { sql: 'starred = 1', needs: 'edit' },
  unstar: { sql: 'starred = 0', needs: 'edit' },
  archive: { sql: "folder = 'archive'", needs: 'edit' },
  inbox: { sql: "folder = 'inbox', snoozed_until = NULL, moved_at = NULL", needs: 'edit' },
  spam: { sql: "folder = 'spam', moved_at = unixepoch() * 1000", needs: 'edit' },
  trash: { sql: "folder = 'trash', moved_at = unixepoch() * 1000", needs: 'delete' },
} as const;

api.post('/threads/:id/actions', async (c) => {
  const p = c.var.principal;
  const body = await c.req.json<{ action?: string; until?: number }>().catch(() => ({}) as { action?: string; until?: number });
  const row = await loadThread(c.env, p, c.req.param('id'));

  if (body.action === 'section') {
    assertCan(p, row.mailbox_id, 'edit');
    const to = (body as { section?: string }).section;
    if (!isSection(to)) throw new HttpError(400, 'bad_section', 'Unknown inbox section.');
    const statements = [c.env.DB.prepare('UPDATE thread SET section = ? WHERE id = ?').bind(to, row.id)];
    // Remember the choice, so the next message from this sender lands in the same section.
    const own = row.last_from_email ? await c.env.DB.prepare('SELECT 1 AS x FROM address WHERE email = ?').bind(row.last_from_email).first() : true;
    if (!own) statements.push(c.env.DB.prepare('INSERT INTO sender_section (email, section, created_at) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET section = excluded.section').bind(row.last_from_email, to, Date.now()));
    await c.env.DB.batch(statements);
  } else if (body.action === 'snooze') {
    assertCan(p, row.mailbox_id, 'edit');
    if (typeof body.until !== 'number' || body.until <= Date.now()) throw new HttpError(422, 'bad_time', 'Pick a time in the future.');
    await c.env.DB.prepare('UPDATE thread SET snoozed_until = ? WHERE id = ?').bind(body.until, row.id).run();
  } else {
    const action = THREAD_ACTIONS[body.action as keyof typeof THREAD_ACTIONS];
    if (!action) throw new HttpError(400, 'bad_action', 'Unknown action.');
    assertCan(p, row.mailbox_id, action.needs);
    const statements = [c.env.DB.prepare(`UPDATE thread SET ${action.sql} WHERE id = ?`).bind(row.id)];
    if (body.action === 'read') statements.push(c.env.DB.prepare('UPDATE message SET unread = 0 WHERE thread_id = ?').bind(row.id));
    // Marking spam teaches the filter to block that sender; taking a conversation out of Spam clears them.
    const sender = row.last_from_email;
    const own = sender ? await c.env.DB.prepare('SELECT 1 AS x FROM address WHERE email = ?').bind(sender).first() : true;
    if (!own && body.action === 'spam') statements.push(c.env.DB.prepare("INSERT INTO sender_rule (email, verdict, created_at) VALUES (?, 'block', ?) ON CONFLICT(email) DO UPDATE SET verdict = 'block'").bind(sender, Date.now()));
    if (!own && body.action === 'inbox' && row.folder === 'spam') statements.push(c.env.DB.prepare("INSERT INTO sender_rule (email, verdict, created_at) VALUES (?, 'allow', ?) ON CONFLICT(email) DO UPDATE SET verdict = 'allow'").bind(sender, Date.now()));
    await c.env.DB.batch(statements);
    if (body.action === 'trash' || body.action === 'spam') await audit(c.env, p, `thread.${body.action}`, row.id, row.subject);
  }
  return c.json(toSummary(await loadThread(c.env, p, row.id)));
});

// ---------- search ----------

api.get('/search', async (c) => {
  const p = c.var.principal;
  const query = ftsQuery(c.req.query('q') ?? '');
  if (!query) return c.json({ data: [] });
  const scope = mailboxScope(p, 't.mailbox_id');
  const mailbox = c.req.query('mailbox');
  const rows = await c.env.DB.prepare(
    `SELECT ${THREAD_COLUMNS}, MAX(m2.at) AS hit_at
       FROM message_fts f JOIN message m2 ON m2.rowid = f.rowid JOIN thread t ON t.id = m2.thread_id JOIN address a ON a.id = t.address_id
      WHERE message_fts MATCH ? AND t.folder != 'trash'${mailbox ? ' AND t.mailbox_id = ?' : ''}${scope.sql}
      GROUP BY t.id ORDER BY hit_at DESC LIMIT 30`,
  ).bind(query, ...(mailbox ? [mailbox] : []), ...scope.params).all<ThreadRow>();
  return c.json({ data: rows.results.map(toSummary) });
});

// ---------- files ----------

api.get('/attachments/:id', async (c) => {
  const p = c.var.principal;
  const row = await c.env.DB.prepare('SELECT a.filename, a.mime, a.r2_key, m.mailbox_id FROM attachment a JOIN message m ON m.id = a.message_id WHERE a.id = ?')
    .bind(c.req.param('id')).first<{ filename: string; mime: string; r2_key: string; mailbox_id: string }>();
  if (!row || !can(p, row.mailbox_id, 'read')) throw new HttpError(404, 'not_found', 'File not found.');
  const object = await c.env.MAIL.get(row.r2_key);
  if (!object) throw new HttpError(404, 'not_found', 'File not found.');
  // Always a download, never rendered in Sadi Mail's own origin.
  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, no-store',
    },
  });
});

api.get('/messages/:id/raw', async (c) => {
  const p = c.var.principal;
  const row = await c.env.DB.prepare('SELECT raw_key, mailbox_id FROM message WHERE id = ?').bind(c.req.param('id')).first<{ raw_key: string | null; mailbox_id: string }>();
  if (!row || !row.raw_key || !can(p, row.mailbox_id, 'read')) throw new HttpError(404, 'not_found', 'Message not found.');
  const object = await c.env.MAIL.get(row.raw_key);
  if (!object) throw new HttpError(404, 'not_found', 'Message not found.');
  return new Response(object.body, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, no-store' } });
});

// ---------- send ----------

api.post('/send', async (c) => {
  const p = c.var.principal;
  const body = await c.req.json<SendRequest>().catch(() => null);
  if (!body || (typeof body.fromAddressId !== 'string' && typeof body.fromEmail !== 'string') || !Array.isArray(body.to)) throw new HttpError(400, 'bad_request', 'A From address and recipients are required.');
  const result = await sendMessage(c.env, p, body);
  await audit(c.env, p, 'message.send', result.messageId, result.status);
  // Undo send: the message waits a few seconds, then leaves from here. The cron trigger is the safety net.
  if (result.status === 'scheduled' && body.undoSeconds && !body.scheduledFor) {
    const wait = Math.min(30, Math.max(1, body.undoSeconds)) * 1000 + 250;
    c.executionCtx.waitUntil(new Promise((resolve) => setTimeout(resolve, wait)).then(() => deliverDue(c.env)).catch(() => undefined));
  }
  return c.json(result);
});

// ---------- addresses ----------

api.patch('/addresses/:id', async (c) => {
  const p = c.var.principal;
  const body = await c.req.json<{ displayName?: string; signature?: string; isDefault?: boolean; signatureFields?: unknown }>().catch(() => ({}) as Record<string, never>);
  const row = await c.env.DB.prepare('SELECT id, mailbox_id FROM address WHERE id = ?').bind(c.req.param('id')).first<{ id: string; mailbox_id: string }>();
  if (!row || !can(p, row.mailbox_id, 'read')) throw new HttpError(404, 'not_found', 'Address not found.');
  if (!isAdmin(p)) throw new HttpError(403, 'forbidden', 'Only an owner or admin can change an address.');
  const statements: D1PreparedStatement[] = [];
  if (typeof body.displayName === 'string') statements.push(c.env.DB.prepare('UPDATE address SET display_name = ? WHERE id = ?').bind(body.displayName.trim().slice(0, 120), row.id));
  if (typeof body.signature === 'string') statements.push(c.env.DB.prepare('UPDATE address SET signature = ? WHERE id = ?').bind(body.signature.slice(0, 4000), row.id));
  if (body.signatureFields !== undefined) {
    // Built on the server from the fields, so the stored HTML is always our own escaped markup.
    const fields = parseSignature(body.signatureFields);
    statements.push(c.env.DB.prepare('UPDATE address SET signature = ?, signature_html = ?, signature_json = ? WHERE id = ?').bind(signatureText(fields), signatureHtml(fields) || null, JSON.stringify(fields), row.id));
  }
  if (body.isDefault === true) {
    statements.push(c.env.DB.prepare('UPDATE address SET is_default = 0 WHERE mailbox_id = ?').bind(row.mailbox_id), c.env.DB.prepare('UPDATE address SET is_default = 1 WHERE id = ?').bind(row.id));
  }
  if (statements.length) await c.env.DB.batch(statements);
  await audit(c.env, p, 'address.update', row.id);
  return c.json({ ok: true });
});

api.post('/addresses', async (c) => {
  const p = c.var.principal;
  if (!isAdmin(p)) throw new HttpError(403, 'forbidden', 'Only an owner or admin can add an address.');
  const body = await c.req.json<{ mailboxId?: string; email?: string; displayName?: string }>().catch(() => ({}) as Record<string, never>);
  const email = normaliseEmail(body.email ?? '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(422, 'invalid_email', 'Enter a full email address.');
  const mailbox = await c.env.DB.prepare('SELECT id FROM mailbox WHERE id = ?').bind(body.mailboxId ?? '').first();
  if (!mailbox) throw new HttpError(404, 'not_found', 'Mailbox not found.');
  const exists = await c.env.DB.prepare('SELECT 1 AS x FROM address WHERE email = ?').bind(email).first();
  if (exists) throw new HttpError(409, 'exists', 'That address is already set up.');
  const id = newId();
  await c.env.DB.prepare('INSERT INTO address (id, mailbox_id, email, display_name, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, body.mailboxId, email, (body.displayName ?? '').trim(), Date.now()).run();
  await audit(c.env, p, 'address.create', id, email);
  return c.json({ id });
});

// A mailbox with nothing in it yet. Sadi Mail has no screen for this: a host application uses it to give an
// address a mailbox of its own, which can then be granted to one person. Add its first address with POST /addresses.
api.post('/mailboxes', async (c) => {
  const p = c.var.principal;
  if (!isAdmin(p)) throw new HttpError(403, 'forbidden', 'Only an owner or admin can add a mailbox.');
  const body = await c.req.json<{ name?: string }>().catch(() => ({}) as Record<string, never>);
  const name = (typeof body.name === 'string' ? body.name : '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!name) throw new HttpError(422, 'no_name', 'Give the mailbox a name.');
  if (await c.env.DB.prepare('SELECT 1 AS x FROM mailbox WHERE name = ? COLLATE NOCASE').bind(name).first()) throw new HttpError(409, 'exists', 'A mailbox with that name already exists.');
  const position = (await c.env.DB.prepare('SELECT COUNT(*) AS n FROM mailbox').first<{ n: number }>())?.n ?? 0;
  const id = newId();
  await c.env.DB.prepare('INSERT INTO mailbox (id, name, position, created_at) VALUES (?, ?, ?, ?)').bind(id, name, position, Date.now()).run();
  await audit(c.env, p, 'mailbox.create', id, name);
  return c.json({ id });
});

// ---------- people and permissions ----------

const ROLES: Role[] = ['owner', 'admin', 'member', 'viewer'];

api.get('/users', async (c) => {
  const p = c.var.principal;
  if (!isAdmin(p)) throw new HttpError(403, 'forbidden', 'Only an owner or admin can see who has access.');
  const [users, grants] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT id, name, role, status, created_at FROM user ORDER BY created_at'),
    c.env.DB.prepare('SELECT user_id, mailbox_id, can_read, can_send, can_edit, can_delete FROM mailbox_grant'),
  ]);
  const all = grants!.results as { user_id: string; mailbox_id: string; can_read: number; can_send: number; can_edit: number; can_delete: number }[];
  return c.json({
    data: (users!.results as { id: string; name: string; role: Role; status: string; created_at: number }[]).map((u) => ({
      id: u.id, name: u.name, role: u.role, status: u.status, createdAt: u.created_at,
      grants: all.filter((g) => g.user_id === u.id).map((g) => ({ mailboxId: g.mailbox_id, read: !!g.can_read, send: !!g.can_send, edit: !!g.can_edit, delete: !!g.can_delete })),
    })),
  });
});

api.patch('/users/:id', async (c) => {
  const p = c.var.principal;
  if (!isAdmin(p)) throw new HttpError(403, 'forbidden', 'Only an owner or admin can change access.');
  const body = await c.req.json<{ role?: Role; status?: 'active' | 'disabled'; name?: string; grants?: { mailboxId: string; read: boolean; send: boolean; edit: boolean; delete: boolean }[] }>().catch(() => ({}) as Record<string, never>);
  const user = await c.env.DB.prepare('SELECT id, role FROM user WHERE id = ?').bind(c.req.param('id')).first<{ id: string; role: Role }>();
  if (!user) throw new HttpError(404, 'not_found', 'Person not found.');
  // Only an owner may create, change or remove an owner, and the last owner cannot be removed.
  const touchesOwner = user.role === 'owner' || body.role === 'owner';
  if (touchesOwner && p.role !== 'owner') throw new HttpError(403, 'forbidden', 'Only an owner can change an owner.');
  if (user.role === 'owner' && ((body.role && body.role !== 'owner') || body.status === 'disabled')) {
    const owners = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM user WHERE role = 'owner' AND status = 'active'").first<{ n: number }>())?.n ?? 0;
    if (owners <= 1) throw new HttpError(409, 'last_owner', 'There must always be one active owner.');
  }
  const statements: D1PreparedStatement[] = [];
  if (body.role) {
    if (!ROLES.includes(body.role)) throw new HttpError(422, 'bad_role', 'Unknown role.');
    statements.push(c.env.DB.prepare('UPDATE user SET role = ? WHERE id = ?').bind(body.role, user.id));
  }
  if (body.status === 'active' || body.status === 'disabled') statements.push(c.env.DB.prepare('UPDATE user SET status = ? WHERE id = ?').bind(body.status, user.id));
  if (typeof body.name === 'string' && body.name.trim()) statements.push(c.env.DB.prepare('UPDATE user SET name = ? WHERE id = ?').bind(body.name.trim().slice(0, 120), user.id));
  if (Array.isArray(body.grants)) {
    statements.push(c.env.DB.prepare('DELETE FROM mailbox_grant WHERE user_id = ?').bind(user.id));
    for (const g of body.grants) {
      statements.push(
        c.env.DB.prepare('INSERT INTO mailbox_grant (user_id, mailbox_id, can_read, can_send, can_edit, can_delete) VALUES (?, ?, ?, ?, ?, ?)').bind(user.id, g.mailboxId, g.read ? 1 : 0, g.send ? 1 : 0, g.edit ? 1 : 0, g.delete ? 1 : 0),
      );
    }
  }
  if (statements.length) await c.env.DB.batch(statements);
  await audit(c.env, p, 'user.update', user.id, JSON.stringify({ role: body.role, status: body.status, grants: body.grants?.length }));
  return c.json({ ok: true });
});


// ---------- AI: on a conversation ----------

api.get('/threads/:id/ai', async (c) => {
  const p = c.var.principal;
  const row = await loadThread(c.env, p, c.req.param('id'));
  const [notes, agents] = await Promise.all([
    c.env.DB.prepare(
      `SELECT r.id, r.kind, r.at, r.status, r.output, r.error, COALESCE(a.name, CASE r.kind WHEN 'reply' THEN 'Drafted Reply' ELSE 'Assistant' END) AS agent
         FROM agent_run r LEFT JOIN agent a ON a.id = r.agent_id WHERE r.thread_id = ? AND r.kind IN ('reply', 'custom') AND r.status != 'skipped' ORDER BY r.at DESC LIMIT 6`,
    ).bind(row.id).all<AgentNote>(),
    listAgents(c.env),
  ]);
  const body: ThreadAi = {
    brief: await getBrief(c.env, row.id),
    notes: notes.results,
    agents: agents.filter((a) => a.enabled && !a.builtin && (!a.mailbox_id || a.mailbox_id === row.mailbox_id)).map((a) => ({ id: a.id, name: a.name })),
  };
  return c.json(body);
});

api.post('/threads/:id/ai/brief', async (c) => {
  const p = c.var.principal;
  const row = await loadThread(c.env, p, c.req.param('id'));
  return c.json(await buildBrief(c.env, row.id, { userId: p.userId }));
});

api.post('/threads/:id/ai/reply', async (c) => {
  const p = c.var.principal;
  const row = await loadThread(c.env, p, c.req.param('id'));
  assertCan(p, row.mailbox_id, 'send');
  const body = await c.req.json<{ guidance?: string }>().catch(() => ({}) as { guidance?: string });
  return c.json({ text: await draftReply(c.env, row.id, body.guidance ?? '', { userId: p.userId }) });
});

api.post('/threads/:id/ai/agents/:agentId', async (c) => {
  const p = c.var.principal;
  const row = await loadThread(c.env, p, c.req.param('id'));
  const agent = (await listAgents(c.env)).find((a) => a.id === c.req.param('agentId') && !a.builtin && a.enabled);
  if (!agent || (agent.mailbox_id && agent.mailbox_id !== row.mailbox_id)) throw new HttpError(404, 'not_found', 'Agent not found.');
  return c.json({ text: await runCustom(c.env, agent, row.id, { userId: p.userId }) });
});

// ---------- AI: writing that arrives as it is written ----------

// Labelled as an event stream and marked no-transform so nothing between the Worker and the browser
// compresses it: a compressed answer is held back and arrives all at once, which defeats the point.
const STREAM_HEADERS = { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'Content-Encoding': 'identity', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' };

api.post('/threads/:id/ai/reply/stream', async (c) => {
  const p = c.var.principal;
  const row = await loadThread(c.env, p, c.req.param('id'));
  assertCan(p, row.mailbox_id, 'send');
  const body = await c.req.json<{ guidance?: string }>().catch(() => ({}) as { guidance?: string });
  const stream = await draftReplyStream(c.env, row.id, body.guidance ?? '', { userId: p.userId }, (job) => c.executionCtx.waitUntil(job));
  return new Response(stream, { headers: STREAM_HEADERS });
});

api.post('/ai/rewrite/stream', async (c) => {
  const p = c.var.principal;
  if (p.role === 'viewer') throw new HttpError(403, 'forbidden', 'Viewers cannot use AI writing.');
  const body = await c.req.json<{ text?: string; style?: string; language?: string; instruction?: string }>().catch(() => ({}) as Record<string, never>);
  const stream = await rewriteStream(c.env, String(body.text ?? ''), String(body.style ?? ''), String(body.language ?? ''), p.userId, (job) => c.executionCtx.waitUntil(job), String(body.instruction ?? ''));
  return new Response(stream, { headers: STREAM_HEADERS });
});

api.post('/ai/write/stream', async (c) => {
  const p = c.var.principal;
  if (p.role === 'viewer') throw new HttpError(403, 'forbidden', 'Viewers cannot use AI writing.');
  const body = await c.req.json<{ instruction?: string; fromName?: string }>().catch(() => ({}) as Record<string, never>);
  const stream = await writeNewStream(c.env, String(body.instruction ?? ''), String(body.fromName ?? '').slice(0, 120), p.userId, (job) => c.executionCtx.waitUntil(job));
  return new Response(stream, { headers: STREAM_HEADERS });
});

// ---------- AI: writing ----------

const canWrite = (p: Principal) => p.role !== 'viewer';

api.post('/ai/rewrite', async (c) => {
  const p = c.var.principal;
  if (!canWrite(p)) throw new HttpError(403, 'forbidden', 'Viewers cannot use AI writing.');
  const body = await c.req.json<{ text?: string; style?: string; language?: string; instruction?: string }>().catch(() => ({}) as Record<string, never>);
  return c.json({ text: await rewrite(c.env, String(body.text ?? ''), String(body.style ?? ''), String(body.language ?? ''), p.userId, String(body.instruction ?? '')) });
});

api.post('/ai/write', async (c) => {
  const p = c.var.principal;
  if (!canWrite(p)) throw new HttpError(403, 'forbidden', 'Viewers cannot use AI writing.');
  const body = await c.req.json<{ instruction?: string; fromName?: string }>().catch(() => ({}) as Record<string, never>);
  return c.json(await writeNew(c.env, String(body.instruction ?? ''), String(body.fromName ?? '').slice(0, 120), p.userId));
});

// ---------- AI: providers and agents (owner or admin) ----------

const KINDS: ProviderKind[] = ['workers-ai', 'anthropic', 'openai', 'openai-compatible'];
const adminOnly = (p: Principal) => {
  if (!isAdmin(p)) throw new HttpError(403, 'forbidden', 'Only an owner or admin can change AI settings.');
};

api.get('/ai', async (c) => {
  const p = c.var.principal;
  adminOnly(p);
  const db = c.env.DB;
  const agents = await listAgents(c.env);
  const [providers, runs] = await db.batch([
    db.prepare('SELECT id, kind, name, base_url, model, key_cipher, key_last4, priority, enabled FROM ai_provider ORDER BY priority, created_at'),
    db.prepare('SELECT r.id, r.at, r.kind, a.name AS agent, r.status, r.provider, r.model, r.ms, r.tokens_in, r.tokens_out, r.error FROM agent_run r LEFT JOIN agent a ON a.id = r.agent_id ORDER BY r.at DESC LIMIT 25'),
  ]);
  const body: AiOverview = {
    providers: (providers!.results as { id: string; kind: ProviderKind; name: string; base_url: string | null; model: string; key_cipher: string | null; key_last4: string | null; priority: number; enabled: number }[]).map((r): ProviderInfo => ({
      id: r.id, kind: r.kind, name: r.name, model: r.model, baseUrl: r.base_url, keyLast4: r.key_last4, priority: r.priority, enabled: !!r.enabled,
      usable: !!r.enabled && (r.kind === 'workers-ai' ? !!c.env.AI : !!r.key_cipher),
    })),
    agents: agents.map((a): AgentInfo => ({
      id: a.id, name: a.name, kind: a.kind, instructions: a.instructions, trigger: a.trigger, mailboxId: a.mailbox_id, enabled: !!a.enabled, builtin: a.builtin,
      followUpDays: a.follow_up_days, usesAi: a.builtin !== 'follow-up',
    })),
    workersAiBinding: !!c.env.AI,
    canStoreKeys: !!c.env.MAIL_SECRET_KEY,
    callsToday: await callsToday(c.env),
    dailyLimit: Number(c.env.AI_DAILY_LIMIT) || 500,
    defaults: DEFAULT_MODELS,
    runs: (runs!.results as Record<string, unknown>[]).map((r) => ({
      id: r.id as string, at: r.at as number, kind: r.kind as string, agent: (r.agent as string | null) ?? null, status: r.status as string, provider: (r.provider as string | null) ?? null,
      model: (r.model as string | null) ?? null, ms: (r.ms as number | null) ?? null, tokensIn: (r.tokens_in as number | null) ?? null, tokensOut: (r.tokens_out as number | null) ?? null, error: (r.error as string | null) ?? null,
    })),
  };
  return c.json(body);
});

api.post('/ai/providers', async (c) => {
  const p = c.var.principal;
  adminOnly(p);
  const body = await c.req.json<{ kind?: ProviderKind; name?: string; model?: string; baseUrl?: string; key?: string }>().catch(() => ({}) as Record<string, never>);
  const kind = body.kind as ProviderKind;
  if (!KINDS.includes(kind)) throw new HttpError(422, 'bad_kind', 'Choose a provider.');
  const model = (body.model ?? '').trim() || DEFAULT_MODELS[kind];
  if (!model) throw new HttpError(422, 'no_model', 'Enter the model name.');
  const key = (body.key ?? '').trim();
  if (kind !== 'workers-ai' && key.length < 8) throw new HttpError(422, 'no_key', 'Paste the API key for this provider.');
  const baseUrl = kind === 'openai-compatible' ? (body.baseUrl ?? '').trim() : null;
  if (kind === 'openai-compatible' && !/^https:\/\/[^\s]+$/i.test(baseUrl ?? '')) throw new HttpError(422, 'bad_url', 'Enter the provider address, starting with https://');
  const names: Record<ProviderKind, string> = { 'workers-ai': 'Cloudflare Workers AI', anthropic: 'Anthropic', openai: 'OpenAI', 'openai-compatible': 'Custom Provider' };
  const id = newId();
  // Workers AI always goes first; others queue behind whatever is already there.
  const next = kind === 'workers-ai' ? 10 : 100 + ((await c.env.DB.prepare('SELECT COUNT(*) AS n FROM ai_provider').first<{ n: number }>())?.n ?? 0);
  await c.env.DB.prepare('INSERT INTO ai_provider (id, kind, name, base_url, model, key_cipher, key_last4, priority, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)')
    .bind(id, kind, (body.name ?? '').trim().slice(0, 60) || names[kind], baseUrl, model.slice(0, 120), key ? await sealKey(c.env, key) : null, key ? key.slice(-4) : null, next, Date.now())
    .run();
  await audit(c.env, p, 'ai.provider.create', id, kind);
  return c.json({ id });
});

api.patch('/ai/providers/:id', async (c) => {
  const p = c.var.principal;
  adminOnly(p);
  const body = await c.req.json<{ model?: string; enabled?: boolean; key?: string; priority?: number }>().catch(() => ({}) as Record<string, never>);
  const row = await c.env.DB.prepare('SELECT id FROM ai_provider WHERE id = ?').bind(c.req.param('id')).first();
  if (!row) throw new HttpError(404, 'not_found', 'Provider not found.');
  const st: D1PreparedStatement[] = [];
  if (typeof body.model === 'string' && body.model.trim()) st.push(c.env.DB.prepare('UPDATE ai_provider SET model = ? WHERE id = ?').bind(body.model.trim().slice(0, 120), c.req.param('id')));
  if (typeof body.enabled === 'boolean') st.push(c.env.DB.prepare('UPDATE ai_provider SET enabled = ? WHERE id = ?').bind(body.enabled ? 1 : 0, c.req.param('id')));
  if (typeof body.priority === 'number') st.push(c.env.DB.prepare('UPDATE ai_provider SET priority = ? WHERE id = ?').bind(Math.round(body.priority), c.req.param('id')));
  if (typeof body.key === 'string' && body.key.trim().length >= 8) st.push(c.env.DB.prepare('UPDATE ai_provider SET key_cipher = ?, key_last4 = ? WHERE id = ?').bind(await sealKey(c.env, body.key.trim()), body.key.trim().slice(-4), c.req.param('id')));
  if (st.length) await c.env.DB.batch(st);
  await audit(c.env, p, 'ai.provider.update', c.req.param('id'));
  return c.json({ ok: true });
});

api.delete('/ai/providers/:id', async (c) => {
  const p = c.var.principal;
  adminOnly(p);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE agent SET provider_id = NULL WHERE provider_id = ?').bind(c.req.param('id')),
    c.env.DB.prepare('DELETE FROM ai_provider WHERE id = ?').bind(c.req.param('id')),
  ]);
  await audit(c.env, p, 'ai.provider.delete', c.req.param('id'));
  return c.json({ ok: true });
});

/** One tiny real call, so "connected" means it answered and not only that a key was typed. */
api.post('/ai/providers/:id/test', async (c) => {
  const p = c.var.principal;
  adminOnly(p);
  const id = c.req.param('id');
  const all = await activeProviders(c.env);
  const provider = all.find((r) => r.id === id);
  if (!provider) throw new HttpError(409, 'not_usable', 'This provider is switched off, has no key, or its binding is not on.');
  try {
    const completion = await complete(c.env, { system: 'Answer with the single word: ready', user: 'Are you there?', maxTokens: 20 }, provider);
    await logRun(c.env, { kind: 'test', userId: p.userId, status: 'ok', completion });
    return c.json({ ok: true, ms: completion.ms, model: completion.model });
  } catch (err) {
    await logRun(c.env, { kind: 'test', userId: p.userId, status: 'failed', error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
});

api.post('/ai/agents', async (c) => {
  const p = c.var.principal;
  adminOnly(p);
  const body = await c.req.json<{ name?: string; instructions?: string; trigger?: string; mailboxId?: string | null }>().catch(() => ({}) as Record<string, never>);
  const name = (body.name ?? '').trim().slice(0, 60);
  const instructions = (body.instructions ?? '').trim().slice(0, 4000);
  if (!name) throw new HttpError(422, 'no_name', 'Give the agent a name.');
  if (instructions.length < 10) throw new HttpError(422, 'no_instructions', 'Tell the agent what to do, in a sentence or more.');
  const trigger = body.trigger === 'on-receive' ? 'on-receive' : 'manual';
  const id = newId();
  await c.env.DB.prepare("INSERT INTO agent (id, name, kind, instructions, trigger, mailbox_id, enabled, created_at) VALUES (?, ?, 'custom', ?, ?, ?, 1, ?)").bind(id, name, instructions, trigger, body.mailboxId || null, Date.now()).run();
  await audit(c.env, p, 'ai.agent.create', id, name);
  return c.json({ id });
});

api.patch('/ai/agents/:id', async (c) => {
  const p = c.var.principal;
  adminOnly(p);
  const body = await c.req.json<{ enabled?: boolean; name?: string; instructions?: string; trigger?: string; followUpDays?: number }>().catch(() => ({}) as Record<string, never>);
  const agent = await c.env.DB.prepare('SELECT id, builtin FROM agent WHERE id = ?').bind(c.req.param('id')).first<{ id: string; builtin: string | null }>();
  if (!agent) throw new HttpError(404, 'not_found', 'Agent not found.');
  const st: D1PreparedStatement[] = [];
  if (typeof body.enabled === 'boolean') st.push(c.env.DB.prepare('UPDATE agent SET enabled = ? WHERE id = ?').bind(body.enabled ? 1 : 0, agent.id));
  if (typeof body.instructions === 'string') st.push(c.env.DB.prepare('UPDATE agent SET instructions = ? WHERE id = ?').bind(body.instructions.trim().slice(0, 4000), agent.id));
  if (typeof body.followUpDays === 'number') st.push(c.env.DB.prepare('UPDATE agent SET follow_up_days = ? WHERE id = ?').bind(Math.min(30, Math.max(1, Math.round(body.followUpDays))), agent.id));
  if (!agent.builtin) {
    if (typeof body.name === 'string' && body.name.trim()) st.push(c.env.DB.prepare('UPDATE agent SET name = ? WHERE id = ?').bind(body.name.trim().slice(0, 60), agent.id));
    if (body.trigger === 'manual' || body.trigger === 'on-receive') st.push(c.env.DB.prepare('UPDATE agent SET trigger = ? WHERE id = ?').bind(body.trigger, agent.id));
  }
  if (st.length) await c.env.DB.batch(st);
  await audit(c.env, p, 'ai.agent.update', agent.id, JSON.stringify({ enabled: body.enabled }));
  return c.json({ ok: true });
});

api.delete('/ai/agents/:id', async (c) => {
  const p = c.var.principal;
  adminOnly(p);
  const agent = await c.env.DB.prepare('SELECT id, builtin FROM agent WHERE id = ?').bind(c.req.param('id')).first<{ id: string; builtin: string | null }>();
  if (!agent) throw new HttpError(404, 'not_found', 'Agent not found.');
  if (agent.builtin) throw new HttpError(409, 'builtin', 'Ready-made agents can be switched off, not deleted.');
  await c.env.DB.batch([c.env.DB.prepare('UPDATE agent_run SET agent_id = NULL WHERE agent_id = ?').bind(agent.id), c.env.DB.prepare('DELETE FROM agent WHERE id = ?').bind(agent.id)]);
  await audit(c.env, p, 'ai.agent.delete', agent.id);
  return c.json({ ok: true });
});

// ---------- the signed-in person's information card ----------

api.get('/me/profile', async (c) => {
  const p = c.var.principal;
  const row = await c.env.DB.prepare('SELECT name, profile_json FROM user WHERE id = ?').bind(p.userId).first<{ name: string; profile_json: string | null }>();
  let fields = parseProfile(null);
  try { fields = parseProfile(JSON.parse(row?.profile_json || 'null')); } catch { /* unreadable: start empty */ }
  if (!fields.name) fields.name = row?.name ?? p.name;
  return c.json({ profile: fields, forAi: profileForAi(fields) });
});

api.patch('/me/profile', async (c) => {
  const p = c.var.principal;
  const fields = parseProfile(await c.req.json().catch(() => null));
  if (!fields.name) throw new HttpError(422, 'no_name', 'Your name cannot be empty.');
  await c.env.DB.prepare('UPDATE user SET name = ?, profile_json = ? WHERE id = ?').bind(fields.name, JSON.stringify(fields), p.userId).run();
  return c.json({ profile: fields, forAi: profileForAi(fields) });
});

// ---------- the signed-in person's picture ----------

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

api.put('/me/avatar', async (c) => {
  const p = c.var.principal;
  const type = (c.req.header('content-type') ?? '').split(';')[0]!.trim();
  if (!IMAGE_TYPES.includes(type)) throw new HttpError(422, 'bad_image', 'Use a PNG, JPEG or WebP picture.');
  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength > 1024 * 1024) throw new HttpError(422, 'too_large', 'The picture must be under 1 MB.');
  const key = `avatar/${p.userId}`;
  await c.env.MAIL.put(key, bytes, { httpMetadata: { contentType: type } });
  await c.env.DB.prepare('UPDATE user SET avatar_key = ? WHERE id = ?').bind(key, p.userId).run();
  return c.json({ ok: true });
});

api.delete('/me/avatar', async (c) => {
  const p = c.var.principal;
  await c.env.MAIL.delete(`avatar/${p.userId}`);
  await c.env.DB.prepare('UPDATE user SET avatar_key = NULL WHERE id = ?').bind(p.userId).run();
  return c.json({ ok: true });
});

api.get('/users/:id/avatar', async (c) => {
  const row = await c.env.DB.prepare('SELECT avatar_key FROM user WHERE id = ?').bind(c.req.param('id')).first<{ avatar_key: string | null }>();
  const object = row?.avatar_key ? await c.env.MAIL.get(row.avatar_key) : null;
  if (!object) throw new HttpError(404, 'not_found', 'No picture.');
  const type = object.httpMetadata?.contentType ?? '';
  return new Response(object.body, { headers: { 'Content-Type': IMAGE_TYPES.includes(type) ? type : 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, max-age=300' } });
});

// ---------- status ----------

api.get('/status', async (c) => {
  const p = c.var.principal;
  if (!isAdmin(p)) throw new HttpError(403, 'forbidden', 'Only an owner or admin can see system status.');
  const db = c.env.DB;
  const [totals, domains, recent, providers, sent] = await db.batch([
    db.prepare("SELECT COUNT(*) AS messages, COALESCE(SUM(size), 0) AS bytes, MAX(CASE WHEN direction = 'in' THEN at END) AS last_in FROM message"),
    db.prepare('SELECT d.name, d.catch_all, mb.name AS mailbox, (SELECT COUNT(*) FROM address a WHERE a.email LIKE \'%@\' || d.name) AS addresses FROM domain d JOIN mailbox mb ON mb.id = d.mailbox_id ORDER BY d.name'),
    db.prepare(
      `SELECT m.at, m.direction, m.from_email, m.to_json, m.status,
              (SELECT SUM(e.ms) FROM message_event e WHERE e.message_id = m.id) AS ms
         FROM message m ORDER BY m.at DESC LIMIT 12`,
    ),
    db.prepare('SELECT 1 AS x'),
    db.prepare("SELECT COUNT(*) AS n FROM message WHERE status = 'sent'"),
  ]);
  const t = totals!.results[0] as { messages: number; bytes: number; last_in: number | null };
  const live = c.env.SEND_MODE === 'cloudflare';
  const body: SystemStatus = {
    receiving: { state: t.last_in ? 'working' : 'untested', lastReceivedAt: t.last_in },
    storage: { state: 'working', messages: t.messages, bytes: t.bytes },
    sending: { state: !live ? 'dry-run' : (sent!.results[0] as { n: number }).n > 0 ? 'working' : 'configured-untested', mode: live ? 'cloudflare' : 'dry-run' },
    ai: await activeProviders(c.env).then((list) => ({ state: list.length ? ('connected' as const) : ('not-connected' as const), providers: list.map((x) => ({ name: x.name, kind: x.kind, model: x.model })) })),
    domains: (domains!.results as { name: string; catch_all: number; mailbox: string; addresses: number }[]).map((d) => ({ name: d.name, mailbox: d.mailbox, addresses: d.addresses, catchAll: !!d.catch_all })),
    recent: (recent!.results as { at: number; direction: 'in' | 'out'; from_email: string; to_json: string; status: string; ms: number | null }[]).map((r) => ({
      at: r.at, direction: r.direction, from: r.from_email, to: (JSON.parse(r.to_json) as Person[]).map((x) => x.email).join(', '), status: r.status, ms: r.ms,
    })),
  };
  return c.json(body);
});

registerExtras(api);
registerPurge(api);
registerServers(api);
registerBulk(api);
registerMedia(api);
registerRules(api);
registerImport(api);

api.all('*', () => {
  throw new HttpError(404, 'not_found', 'No such endpoint.');
});
