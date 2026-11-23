import type { Hono } from 'hono';
import type { RuleInfo } from '../shared/types';
import { HttpError, type Principal, audit, isAdmin } from './auth';
import { type Env, newId } from './util';

type App = Hono<{ Bindings: Env; Variables: { principal: Principal } }>;
type Match = RuleInfo['match'];
type Action = RuleInfo['action'];

const MAX_TEXT = 200;
const MOVES = ['archive', 'spam', 'trash'] as const;
const TEXT_PARTS = ['from', 'to', 'subject', 'body'] as const;
const RUN_LIMIT = 500;

interface RuleRow { id: string; name: string; mailbox_id: string | null; enabled: number; match_json: string; action_json: string }

/** What a rule looks at: the newest inbound message plus the conversation it belongs to. */
interface Subject { threadId: string; fromName: string; fromEmail: string; to: string; subject: string; body: string; hasAttachment: boolean }

/** Stored JSON is only trusted after a shape check; anything unexpected reads as "no rule". */
function parseJson<T extends object>(text: string): T | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as T) : null;
  } catch {
    return null;
  }
}

/** Does every given part of the match hold? An empty match never does. */
function matches(match: Match, s: Subject): boolean {
  let parts = 0;
  for (const key of TEXT_PARTS) {
    const needle = match[key];
    if (needle === undefined || needle === null) continue;
    if (typeof needle !== 'string' || !needle.trim()) return false;
    parts++;
    const n = needle.trim().toLowerCase();
    const haystack = key === 'from' ? `${s.fromName}\n${s.fromEmail}` : key === 'to' ? s.to : key === 'subject' ? s.subject : s.body;
    if (!haystack.toLowerCase().includes(n)) return false;
  }
  if (match.hasAttachment === true) {
    parts++;
    if (!s.hasAttachment) return false;
  }
  return parts > 0;
}

/** The statements that carry out one rule's actions on one conversation. */
function actionStatements(env: Env, action: Action, threadId: string): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  if (typeof action.labelId === 'string') {
    // Selecting from label skips silently when the label has since been deleted.
    out.push(env.DB.prepare('INSERT OR IGNORE INTO thread_label (thread_id, label_id) SELECT ?, id FROM label WHERE id = ?').bind(threadId, action.labelId));
  }
  if (action.star === true) out.push(env.DB.prepare('UPDATE thread SET starred = 1 WHERE id = ?').bind(threadId));
  if (action.markRead === true) {
    out.push(env.DB.prepare('UPDATE thread SET unread_count = 0 WHERE id = ?').bind(threadId));
    out.push(env.DB.prepare('UPDATE message SET unread = 0 WHERE thread_id = ? AND unread = 1').bind(threadId));
  }
  if (action.moveTo && (MOVES as readonly string[]).includes(action.moveTo)) {
    out.push(env.DB.prepare("UPDATE thread SET folder = ? WHERE id = ? AND folder != 'trash'").bind(action.moveTo, threadId));
  }
  return out;
}

interface SubjectRow {
  thread_id: string; mailbox_id: string; from_name: string | null; from_email: string | null; subject: string | null; body_text: string | null; has_attachment: number; address_email: string | null;
}
const SUBJECT_SELECT = `SELECT t.id AS thread_id, t.mailbox_id, t.has_attachment, a.email AS address_email, m.from_name, m.from_email, m.subject, m.body_text
  FROM thread t
  LEFT JOIN address a ON a.id = t.address_id
  JOIN message m ON m.id = (SELECT id FROM message WHERE thread_id = t.id AND direction = 'in' ORDER BY at DESC, id DESC LIMIT 1)`;

const subjectOf = (r: SubjectRow): Subject => ({
  threadId: r.thread_id, fromName: r.from_name ?? '', fromEmail: r.from_email ?? '', to: r.address_email ?? '', subject: r.subject ?? '', body: r.body_text ?? '', hasAttachment: !!r.has_attachment,
});

const readRule = (r: RuleRow): { match: Match; action: Action } | null => {
  const match = parseJson<Match>(r.match_json);
  const action = parseJson<Action>(r.action_json);
  return match && action ? { match, action } : null;
};

/** Apply every enabled rule to a conversation that has just received a message. Called from ingest. */
export async function applyRules(env: Env, threadId: string): Promise<void> {
  try {
    const row = await env.DB.prepare(`${SUBJECT_SELECT} WHERE t.id = ?`).bind(threadId).first<SubjectRow>();
    if (!row) return;
    const rules = await env.DB.prepare('SELECT id, name, mailbox_id, enabled, match_json, action_json FROM rule WHERE enabled = 1 AND (mailbox_id IS NULL OR mailbox_id = ?) ORDER BY position, created_at')
      .bind(row.mailbox_id).all<RuleRow>();
    const subject = subjectOf(row);
    const statements: D1PreparedStatement[] = [];
    for (const rule of rules.results) {
      const parsed = readRule(rule);
      if (parsed && matches(parsed.match, subject)) statements.push(...actionStatements(env, parsed.action, threadId));
    }
    if (statements.length) await env.DB.batch(statements);
  } catch {
    // Rules are a convenience: a failure here must never lose or delay incoming mail.
  }
}

const toInfo = (r: RuleRow): RuleInfo => ({
  id: r.id, name: r.name, mailboxId: r.mailbox_id, enabled: !!r.enabled, match: parseJson<Match>(r.match_json) ?? {}, action: parseJson<Action>(r.action_json) ?? {},
});

const bad = (code: string, message: string) => new HttpError(422, code, message);

/** Check what a person sent and reduce it to a clean rule. */
async function cleanInput(env: Env, body: unknown): Promise<{ name: string; mailboxId: string | null; match: Match; action: Action }> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) throw bad('no_name', 'Give the rule a name.');
  if (name.length > 60) throw bad('name_too_long', 'A rule name can be at most 60 characters.');

  const rawMatch = (b.match && typeof b.match === 'object' ? b.match : {}) as Record<string, unknown>;
  const match: Match = {};
  for (const key of TEXT_PARTS) {
    const v = rawMatch[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') throw bad('bad_condition', 'Conditions must be text.');
    const t = v.trim();
    if (t.length > MAX_TEXT) throw bad('condition_too_long', `A condition can be at most ${MAX_TEXT} characters.`);
    if (t) match[key] = t;
  }
  if (rawMatch.hasAttachment === true) match.hasAttachment = true;
  if (Object.keys(match).length === 0) throw bad('no_condition', 'Add at least one condition.');

  const rawAction = (b.action && typeof b.action === 'object' ? b.action : {}) as Record<string, unknown>;
  const action: Action = {};
  if (rawAction.labelId !== undefined && rawAction.labelId !== null && rawAction.labelId !== '') {
    if (typeof rawAction.labelId !== 'string' || !(await env.DB.prepare('SELECT id FROM label WHERE id = ?').bind(rawAction.labelId).first())) throw bad('unknown_label', 'That label does not exist.');
    action.labelId = rawAction.labelId;
  }
  if (rawAction.star === true) action.star = true;
  if (rawAction.markRead === true) action.markRead = true;
  if (rawAction.moveTo !== undefined && rawAction.moveTo !== null && rawAction.moveTo !== '') {
    if (typeof rawAction.moveTo !== 'string' || !(MOVES as readonly string[]).includes(rawAction.moveTo)) throw bad('bad_move', 'Move To must be Archive, Spam or Trash.');
    action.moveTo = rawAction.moveTo as Action['moveTo'];
  }
  if (Object.keys(action).length === 0) throw bad('no_action', 'Choose at least one action.');

  let mailboxId: string | null = null;
  if (b.mailboxId !== undefined && b.mailboxId !== null && b.mailboxId !== '') {
    if (typeof b.mailboxId !== 'string' || !(await env.DB.prepare('SELECT id FROM mailbox WHERE id = ?').bind(b.mailboxId).first())) throw bad('unknown_mailbox', 'That mailbox does not exist.');
    mailboxId = b.mailboxId;
  }
  return { name, mailboxId, match, action };
}

async function loadRule(env: Env, id: string): Promise<RuleRow> {
  const row = await env.DB.prepare('SELECT id, name, mailbox_id, enabled, match_json, action_json FROM rule WHERE id = ?').bind(id).first<RuleRow>();
  if (!row) throw new HttpError(404, 'not_found', 'Rule not found.');
  return row;
}

function requireAdmin(p: Principal): void {
  if (!isAdmin(p)) throw new HttpError(403, 'forbidden', 'Only owners and admins can manage rules.');
}

/** Routes under /api/rules. Registered from api.ts. */
export function registerRules(api: App): void {
  api.get('/rules', async (c) => {
    requireAdmin(c.var.principal);
    const rows = await c.env.DB.prepare('SELECT id, name, mailbox_id, enabled, match_json, action_json FROM rule ORDER BY position, created_at').all<RuleRow>();
    return c.json({ data: rows.results.map(toInfo) });
  });

  /** Create a rule, or update it when an id is given. */
  api.post('/rules', async (c) => {
    const p = c.var.principal;
    requireAdmin(p);
    const raw = await c.req.json<Record<string, unknown>>().catch(() => null);
    const input = await cleanInput(c.env, raw);
    const id = typeof raw?.id === 'string' ? raw.id : '';
    if (id) {
      await loadRule(c.env, id);
      await c.env.DB.prepare('UPDATE rule SET name = ?, mailbox_id = ?, match_json = ?, action_json = ? WHERE id = ?')
        .bind(input.name, input.mailboxId, JSON.stringify(input.match), JSON.stringify(input.action), id).run();
      await audit(c.env, p, 'rule.update', id, input.name);
      return c.json(toInfo(await loadRule(c.env, id)));
    }
    const now = Date.now();
    const newRuleId = newId(now);
    await c.env.DB.prepare('INSERT INTO rule (id, name, mailbox_id, position, enabled, match_json, action_json, created_at) VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM rule), 1, ?, ?, ?)')
      .bind(newRuleId, input.name, input.mailboxId, JSON.stringify(input.match), JSON.stringify(input.action), now).run();
    await audit(c.env, p, 'rule.create', newRuleId, input.name);
    return c.json(toInfo(await loadRule(c.env, newRuleId)));
  });

  api.patch('/rules/:id', async (c) => {
    const p = c.var.principal;
    requireAdmin(p);
    const rule = await loadRule(c.env, c.req.param('id'));
    const body = await c.req.json<{ enabled?: unknown }>().catch(() => ({}) as { enabled?: unknown });
    if (typeof body.enabled !== 'boolean') throw bad('bad_request', 'Say whether the rule is on or off.');
    await c.env.DB.prepare('UPDATE rule SET enabled = ? WHERE id = ?').bind(body.enabled ? 1 : 0, rule.id).run();
    await audit(c.env, p, 'rule.update', rule.id, body.enabled ? 'enabled' : 'disabled');
    return c.json(toInfo(await loadRule(c.env, rule.id)));
  });

  api.delete('/rules/:id', async (c) => {
    const p = c.var.principal;
    requireAdmin(p);
    const rule = await loadRule(c.env, c.req.param('id'));
    await c.env.DB.prepare('DELETE FROM rule WHERE id = ?').bind(rule.id).run();
    await audit(c.env, p, 'rule.delete', rule.id, rule.name);
    return c.json({ ok: true });
  });

  /** Tidy existing mail: apply this one rule to the 500 most recent conversations in the inbox. */
  api.post('/rules/:id/run', async (c) => {
    const p = c.var.principal;
    requireAdmin(p);
    const rule = await loadRule(c.env, c.req.param('id'));
    const parsed = readRule(rule);
    if (!parsed) throw bad('broken_rule', 'This rule is damaged. Edit and save it again.');
    const rows = await c.env.DB.prepare(`${SUBJECT_SELECT} WHERE t.folder = 'inbox' AND (? IS NULL OR t.mailbox_id = ?) ORDER BY t.last_at DESC LIMIT ?`)
      .bind(rule.mailbox_id, rule.mailbox_id, RUN_LIMIT).all<SubjectRow>();
    const statements: D1PreparedStatement[] = [];
    let matched = 0;
    for (const row of rows.results) {
      const subject = subjectOf(row);
      if (!matches(parsed.match, subject)) continue;
      matched++;
      statements.push(...actionStatements(c.env, parsed.action, subject.threadId));
    }
    for (let i = 0; i < statements.length; i += 90) await c.env.DB.batch(statements.slice(i, i + 90));
    await audit(c.env, p, 'rule.run', rule.id, `${matched} matched`);
    return c.json({ matched });
  });
}
