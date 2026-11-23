// Bulk sending. A job holds the message once and the list of people; the timer sends a few each
// minute through the same path as any other message, so every copy is a normal entry in Sent.
import type { Hono } from 'hono';
import { BULK_MAX, BULK_RATES, type BulkPerson, parseRecipients, personalise } from '../shared/bulk';
import type { BulkJobInfo } from '../shared/types';
import { HttpError, type Principal, assertCan, audit, isAdmin } from './auth';
import { sendMessage } from './send';
import { type Env, newId } from './util';

type App = Hono<{ Bindings: Env; Variables: { principal: Principal } }>;

interface Job {
  id: string; user_id: string; from_address_id: string; subject: string; body_text: string; body_html: string | null; recipients_json: string;
  total: number; next_index: number; sent: number; failed: number; per_minute: number; status: 'running' | 'done' | 'cancelled';
  start_at: number; last_error: string | null; created_at: number; finished_at: number | null; from_email?: string; by?: string;
}

const info = (j: Job): BulkJobInfo => ({
  id: j.id, subject: j.subject, fromEmail: j.from_email ?? '', by: j.by ?? '', total: j.total, done: j.next_index, sent: j.sent, failed: j.failed,
  perMinute: j.per_minute, status: j.status, startAt: j.start_at, createdAt: j.created_at, finishedAt: j.finished_at, lastError: j.last_error,
});

/** Send the next few of one job. Each person gets their own message; one failure never stops the rest. */
async function step(env: Env, job: Job): Promise<void> {
  // Take the batch first, so two timers running at once can never send to the same people.
  const upto = Math.min(job.total, job.next_index + job.per_minute);
  const claim = await env.DB.prepare("UPDATE bulk_job SET next_index = ? WHERE id = ? AND next_index = ? AND status = 'running'").bind(upto, job.id, job.next_index).run();
  if (!claim.meta.changes) return;
  const people = (JSON.parse(job.recipients_json) as BulkPerson[]).slice(job.next_index, upto);
  // The person who started the job was allowed to send from this address when they started it.
  const sender: Principal = { userId: job.user_id, name: '', role: 'owner', grants: new Map() };
  let sent = 0;
  let failed = 0;
  let lastError: string | null = null;
  for (const person of people) {
    try {
      const result = await sendMessage(env, sender, {
        fromAddressId: job.from_address_id, to: [person], subject: personalise(job.subject, person), text: personalise(job.body_text, person),
        html: job.body_html ? personalise(job.body_html, person, true) : undefined,
      });
      if (result.status === 'failed') { failed++; lastError = `${person.email} could not be sent.`; } else sent++;
    } catch (err) {
      failed++;
      lastError = `${person.email}: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`;
    }
  }
  const finished = upto >= job.total;
  await env.DB.prepare("UPDATE bulk_job SET sent = sent + ?, failed = failed + ?, last_error = COALESCE(?, last_error), status = CASE WHEN ? AND status = 'running' THEN 'done' ELSE status END, finished_at = CASE WHEN ? THEN ? ELSE finished_at END WHERE id = ?")
    .bind(sent, failed, lastError, finished ? 1 : 0, finished ? 1 : 0, Date.now(), job.id).run();
}

/** Called by the timer each minute. */
export async function runBulk(env: Env, now: number = Date.now()): Promise<void> {
  let jobs: Job[] = [];
  try {
    jobs = (await env.DB.prepare("SELECT * FROM bulk_job WHERE status = 'running' AND start_at <= ? ORDER BY created_at LIMIT 3").bind(now).all<Job>()).results;
  } catch {
    return;
  }
  for (const job of jobs) await step(env, job).catch((err) => console.error(JSON.stringify({ at: 'bulk.step', id: job.id, error: String(err) })));
}

export function registerBulk(api: App): void {
  const SELECT = 'SELECT j.*, a.email AS from_email, u.name AS by FROM bulk_job j JOIN address a ON a.id = j.from_address_id JOIN user u ON u.id = j.user_id';

  api.post('/bulk', async (c) => {
    const p = c.var.principal;
    const body = await c.req.json<{ fromAddressId?: string; recipients?: string; subject?: string; text?: string; html?: string; perMinute?: number; startAt?: number }>().catch(() => ({}) as Record<string, never>);
    const address = await c.env.DB.prepare('SELECT id, mailbox_id FROM address WHERE id = ?').bind(String(body.fromAddressId ?? '')).first<{ id: string; mailbox_id: string }>();
    if (!address) throw new HttpError(404, 'not_found', 'That From address does not exist.');
    assertCan(p, address.mailbox_id, 'send');
    if (p.role === 'viewer') throw new HttpError(403, 'forbidden', 'Viewers cannot send.');
    const { people, invalid } = parseRecipients(String(body.recipients ?? ''));
    if (invalid.length) throw new HttpError(422, 'invalid_recipient', `${invalid.length} line(s) are not email addresses, starting with "${invalid[0]}".`);
    if (people.length < 2) throw new HttpError(422, 'too_few', 'A bulk send needs at least two people. Use a normal message for one.');
    if (people.length > BULK_MAX) throw new HttpError(422, 'too_many', `A bulk send can reach at most ${BULK_MAX} people at a time.`);
    const subject = String(body.subject ?? '').trim();
    const text = String(body.text ?? '');
    if (!subject) throw new HttpError(422, 'no_subject', 'Give the message a subject before sending it to a list.');
    if (!text.trim()) throw new HttpError(422, 'empty', 'Write a message before sending.');
    const perMinute = (BULK_RATES as readonly number[]).includes(Number(body.perMinute)) ? Number(body.perMinute) : 10;
    const now = Date.now();
    const startAt = typeof body.startAt === 'number' && body.startAt > now ? body.startAt : now;
    const id = newId();
    await c.env.DB.prepare(
      'INSERT INTO bulk_job (id, user_id, from_address_id, subject, body_text, body_html, recipients_json, total, per_minute, start_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(id, p.userId, address.id, subject.slice(0, 300), text.slice(0, 200_000), typeof body.html === 'string' ? body.html.slice(0, 400_000) : null, JSON.stringify(people), people.length, perMinute, startAt, now).run();
    await audit(c.env, p, 'bulk.start', id, `${people.length} recipients`);
    if (startAt <= now) c.executionCtx.waitUntil(runBulk(c.env));
    return c.json(info((await c.env.DB.prepare(`${SELECT} WHERE j.id = ?`).bind(id).first<Job>())!));
  });

  /** People see their own bulk sends; owners and admins see everyone's. */
  api.get('/bulk', async (c) => {
    const p = c.var.principal;
    const mine = isAdmin(p) ? '' : ' WHERE j.user_id = ?';
    const rows = await c.env.DB.prepare(`${SELECT}${mine} ORDER BY j.created_at DESC LIMIT 20`).bind(...(isAdmin(p) ? [] : [p.userId])).all<Job>();
    return c.json({ data: rows.results.map(info) });
  });

  api.post('/bulk/:id/cancel', async (c) => {
    const p = c.var.principal;
    const job = await c.env.DB.prepare('SELECT * FROM bulk_job WHERE id = ?').bind(c.req.param('id')).first<Job>();
    if (!job || (!isAdmin(p) && job.user_id !== p.userId)) throw new HttpError(404, 'not_found', 'Bulk send not found.');
    await c.env.DB.prepare("UPDATE bulk_job SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'running'").bind(Date.now(), job.id).run();
    await audit(c.env, p, 'bulk.cancel', job.id);
    return c.json(info((await c.env.DB.prepare(`${SELECT} WHERE j.id = ?`).bind(job.id).first<Job>())!));
  });
}
