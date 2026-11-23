import type { Hono } from 'hono';
import PostalMime from 'postal-mime';
import { HttpError, type Principal, isAdmin } from './auth';
import { indexMessage, resolveTarget } from './ingest';
import { BODY_CAP, type Env, baseSubject, htmlToText, newId, normaliseEmail, parseIds, snippetOf, toPeople } from './util';

type App = Hono<{ Bindings: Env; Variables: { principal: Principal } }>;

/** Cloudflare caps a whole message at 25 MiB, so nothing larger can have arrived by mail either. */
const MAX_BYTES = 25 * 1024 * 1024;
const FOLDERS = ['inbox', 'archive', 'sent', 'spam', 'trash'] as const;
type Folder = (typeof FOLDERS)[number];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ImportResult = { status: 'duplicate' } | { status: 'imported'; threadId: string; messageId: string };

interface ThreadSnapshot {
  id: string;
  folder: 'inbox' | 'archive' | 'spam' | 'trash';
  last_at: number;
  last_from_name: string;
  last_from_email: string;
  snippet: string;
  is_bulk: number;
  follow_up: number;
  snoozed_until: number | null;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const flag = (value: string | undefined, fallback: boolean): boolean => (value === undefined || value === '' ? fallback : value === '1' || value === 'true');

/**
 * The conversation a message with these reply headers belongs to. The same lookup indexMessage
 * makes, done first so the conversation's state can be put back if the imported message is older.
 */
async function threadFor(env: Env, mailboxId: string, refs: string[]): Promise<ThreadSnapshot | null> {
  if (refs.length === 0) return null;
  const marks = refs.map(() => '?').join(',');
  const hit = await env.DB.prepare(`SELECT thread_id FROM message WHERE mailbox_id = ? AND message_id IN (${marks}) ORDER BY at DESC LIMIT 1`)
    .bind(mailboxId, ...refs)
    .first<{ thread_id: string }>();
  if (!hit) return null;
  return env.DB.prepare('SELECT id, folder, last_at, last_from_name, last_from_email, snippet, is_bulk, follow_up, snoozed_until FROM thread WHERE id = ?')
    .bind(hit.thread_id)
    .first<ThreadSnapshot>();
}

const event = (env: Env, messageId: string, kind: string, detail: string) =>
  env.DB.prepare('INSERT INTO message_event (id, message_id, at, kind, detail, ms) VALUES (?, ?, ?, ?, ?, NULL)').bind(newId(), messageId, Date.now(), kind, detail);

interface ImportInput {
  bytes: ArrayBuffer;
  address: string;
  folder: Folder;
  read: boolean;
  starred: boolean;
  /** IMAP INTERNALDATE or similar, in ms. Wins over the Date header. */
  date: number | null;
}

/** Bring one existing message into Sadi Mail. Never runs rules or AI agents. */
export async function importMessage(env: Env, principal: Principal, input: ImportInput): Promise<ImportResult> {
  const target = await resolveTarget(env, input.address, true);
  if (!target || !target.addressId) throw new HttpError(404, 'not_found', `Sadi Mail does not take mail for ${input.address}. Add the address or its domain first.`);

  const mail = await PostalMime.parse(input.bytes);
  const messageId = parseIds(mail.messageId)[0] ?? null;
  if (messageId) {
    const seen = await env.DB.prepare('SELECT 1 AS x FROM message WHERE mailbox_id = ? AND message_id = ? LIMIT 1').bind(target.mailboxId, messageId).first();
    if (seen) return { status: 'duplicate' };
  }
  // Every imported copy is stored under a name made from its bytes, so the same file uploaded twice
  // is recognised even when it has no Message-ID.
  const rawKey = `import/${target.mailboxId}/${await sha256Hex(input.bytes)}.eml`;
  const stored = await env.DB.prepare('SELECT 1 AS x FROM message WHERE raw_key = ?').bind(rawKey).first();
  if (stored) return { status: 'duplicate' };

  const headerDate = mail.date ? Date.parse(mail.date) : NaN;
  const at = input.date ?? (Number.isFinite(headerDate) && headerDate > 0 ? headerDate : Date.now());
  const inReplyTo = parseIds(mail.inReplyTo)[0] ?? null;
  const refs = [...new Set([...parseIds(mail.references), ...(inReplyTo ? [inReplyTo] : [])])].slice(-20);
  const prev = await threadFor(env, target.mailboxId, refs);
  const fromEmail = normaliseEmail(mail.from?.address ?? '');

  await env.MAIL.put(rawKey, input.bytes, {
    customMetadata: { from: fromEmail, to: input.address, receivedAt: String(at), imported: String(Date.now()) },
  });

  const result =
    input.folder === 'sent'
      ? await importSent(env, principal, { ...input, at, rawKey, mail, messageId, inReplyTo, refs, prev, addressId: target.addressId, mailboxId: target.mailboxId })
      : await importInbound(env, { ...input, folder: input.folder as Exclude<Folder, 'sent'>, at, rawKey, fromEmail, prev });

  await event(env, result.messageId, 'imported', `Imported into ${input.folder} · dated ${new Date(at).toISOString()}`).run();
  return { status: 'imported', ...result };
}

async function importInbound(
  env: Env,
  input: ImportInput & { folder: Exclude<Folder, 'sent'>; at: number; rawKey: string; fromEmail: string; prev: ThreadSnapshot | null },
): Promise<{ threadId: string; messageId: string }> {
  const { at, rawKey, read, starred, folder } = input;
  const threadId = await indexMessage(env, { id: newId(at), rawKey, bytes: input.bytes, envelopeFrom: input.fromEmail, envelopeTo: input.address, receivedAt: at });
  const row = await env.DB.prepare('SELECT id FROM message WHERE raw_key = ?').bind(rawKey).first<{ id: string }>();
  if (!row) throw new Error('The imported message was not indexed.');

  // indexMessage treats every message as new mail arriving now. Put back what an older message must not change.
  const prev = input.prev && input.prev.id === threadId ? input.prev : null;
  const newest = !prev || at >= prev.last_at;
  const sets = ['last_at = ?', 'folder = ?', 'snoozed_until = ?', 'follow_up = ?', 'unread_count = MAX(unread_count - ?, 0)', 'starred = MAX(starred, ?)'];
  const params: (string | number | null)[] = [
    prev ? Math.max(prev.last_at, at) : at,
    newest ? folder : prev!.folder,
    newest ? null : prev!.snoozed_until,
    newest ? 0 : prev!.follow_up,
    read ? 1 : 0,
    starred ? 1 : 0,
  ];
  if (!newest) {
    sets.push('last_from_name = ?', 'last_from_email = ?', 'snippet = ?', 'is_bulk = ?');
    params.push(prev!.last_from_name, prev!.last_from_email, prev!.snippet, prev!.is_bulk);
  }
  await env.DB.batch([
    env.DB.prepare('UPDATE message SET unread = ? WHERE id = ?').bind(read ? 0 : 1, row.id),
    env.DB.prepare(`UPDATE thread SET ${sets.join(', ')} WHERE id = ?`).bind(...params, threadId),
  ]);
  return { threadId, messageId: row.id };
}

type Parsed = Awaited<ReturnType<typeof PostalMime.parse>>;

async function importSent(
  env: Env,
  principal: Principal,
  input: ImportInput & {
    at: number; rawKey: string; mail: Parsed; messageId: string | null; inReplyTo: string | null; refs: string[];
    prev: ThreadSnapshot | null; addressId: string; mailboxId: string;
  },
): Promise<{ threadId: string; messageId: string }> {
  const { at, mail, prev, addressId, mailboxId } = input;
  const address = await env.DB.prepare('SELECT email, display_name FROM address WHERE id = ?').bind(addressId).first<{ email: string; display_name: string }>();
  if (!address) throw new HttpError(404, 'not_found', 'That address does not exist.');
  const fromName = (mail.from?.name ?? '').trim() || address.display_name;
  const to = toPeople(mail.to);
  const cc = toPeople(mail.cc);
  const bcc = toPeople(mail.bcc).map((p) => ({ ...p, bcc: true }));
  const subject = (mail.subject ?? '').trim() || '(No subject)';
  const fullText = mail.text?.trim() ? mail.text : mail.html ? htmlToText(mail.html) : '';
  const text = fullText.slice(0, BODY_CAP);
  const html = mail.html ? mail.html.slice(0, BODY_CAP) : null;
  const truncated = fullText.length > BODY_CAP || (mail.html?.length ?? 0) > BODY_CAP;
  const snippet = snippetOf(text);
  const files = mail.attachments ?? [];
  const hasFiles = files.some((f) => !(f.related || f.disposition === 'inline')) ? 1 : 0;
  const id = newId(at);

  const statements: D1PreparedStatement[] = [];
  let threadId: string;
  if (prev) {
    threadId = prev.id;
    // SQLite reads the old last_at on the right-hand side, so the snippet only moves for a newer message.
    statements.push(
      env.DB.prepare(
        `UPDATE thread SET snippet = CASE WHEN ? >= last_at THEN ? ELSE snippet END, last_at = MAX(last_at, ?), message_count = message_count + 1,
           has_outbound = 1, has_attachment = MAX(has_attachment, ?), starred = MAX(starred, ?) WHERE id = ?`,
      ).bind(at, snippet, at, hasFiles, input.starred ? 1 : 0, threadId),
    );
  } else {
    threadId = newId(at);
    statements.push(
      env.DB.prepare(
        `INSERT INTO thread (id, mailbox_id, address_id, subject, folder, last_at, last_from_name, last_from_email, snippet, message_count,
           unread_count, has_attachment, has_outbound, starred)
         VALUES (?, ?, ?, ?, 'inbox', ?, ?, ?, ?, 1, 0, ?, 1, ?)`,
      ).bind(threadId, mailboxId, addressId, baseSubject(subject) || subject, at, fromName, address.email, snippet, hasFiles, input.starred ? 1 : 0),
    );
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO message (id, thread_id, mailbox_id, address_id, direction, status, message_id, in_reply_to, refs, from_name, from_email, to_json, cc_json,
         subject, snippet, body_text, body_html, body_truncated, at, size, raw_key, unread, created_by)
       VALUES (?, ?, ?, ?, 'out', 'sent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).bind(
      id, threadId, mailboxId, addressId, input.messageId, input.inReplyTo, input.refs.join(' '), fromName, address.email, JSON.stringify(to),
      JSON.stringify([...cc, ...bcc]), subject, snippet, text, html, truncated ? 1 : 0, at, input.bytes.byteLength, input.rawKey, principal.userId,
    ),
    env.DB.prepare('INSERT INTO message_fts (rowid, subject, sender, recipients, body) SELECT rowid, ?, ?, ?, ? FROM message WHERE id = ?').bind(
      subject, `${fromName} ${address.email}`, [...to, ...cc].map((p) => `${p.name} ${p.email}`).join(' '), text.slice(0, 64 * 1024), id,
    ),
  );

  let n = 0;
  for (const file of files) {
    const key = `att/${id}/${n++}`;
    const content = typeof file.content === 'string' ? new TextEncoder().encode(file.content) : file.content;
    await env.MAIL.put(key, content, { httpMetadata: { contentType: file.mimeType } });
    statements.push(
      env.DB.prepare('INSERT INTO attachment (id, message_id, filename, mime, size, content_id, inline, r2_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(
        newId(), id, file.filename || `attachment-${n}`, file.mimeType || 'application/octet-stream', content.byteLength,
        file.contentId ?? null, file.related || file.disposition === 'inline' ? 1 : 0, key,
      ),
    );
  }
  statements.push(event(env, id, 'stored', `R2 · ${input.rawKey}`));
  await env.DB.batch(statements);
  return { threadId, messageId: id };
}

/** Routes under /api/import. Registered from api.ts. */
export function registerImport(api: App): void {
  /** One raw RFC 5322 message per request. The command-line importer (scripts/import.mjs) calls this. */
  api.post('/import/message', async (c) => {
    const p = c.var.principal;
    if (!isAdmin(p)) throw new HttpError(403, 'forbidden', 'Only an owner or admin can import mail.');

    const address = normaliseEmail(c.req.query('address') ?? '');
    if (!EMAIL.test(address)) throw new HttpError(422, 'invalid_address', 'Say which Sadi Mail address the mail belongs to, for example ?address=you@example.com.');
    const folder = (c.req.query('folder') ?? 'inbox') as Folder;
    if (!FOLDERS.includes(folder)) throw new HttpError(422, 'bad_folder', 'The folder must be inbox, archive, sent, spam or trash.');
    const dateParam = c.req.query('date');
    const date = dateParam ? Number(dateParam) : null;
    if (date !== null && !(Number.isFinite(date) && date > 0)) throw new HttpError(422, 'bad_date', 'The date must be a time in milliseconds since 1970.');

    const declared = Number(c.req.header('content-length') ?? '0');
    if (declared > MAX_BYTES) throw new HttpError(422, 'too_large', 'A message can be at most 25 MiB.');
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength === 0) throw new HttpError(422, 'empty', 'The request has no message in it.');
    if (bytes.byteLength > MAX_BYTES) throw new HttpError(422, 'too_large', 'A message can be at most 25 MiB.');

    const result = await importMessage(c.env, p, {
      bytes,
      address,
      folder,
      read: flag(c.req.query('read'), true),
      starred: flag(c.req.query('starred'), false),
      date,
    });
    return c.json(result);
  });

  /** How much has been imported so far, counted from the 'imported' activity entries. */
  api.get('/import/status', async (c) => {
    if (!isAdmin(c.var.principal)) throw new HttpError(403, 'forbidden', 'Only an owner or admin can see imports.');
    const row = await c.env.DB.prepare(
      `SELECT COUNT(*) AS messages, COALESCE(SUM(m.size), 0) AS bytes, MAX(e.at) AS last
         FROM message_event e JOIN message m ON m.id = e.message_id WHERE e.kind = 'imported'`,
    ).first<{ messages: number; bytes: number; last: number | null }>();
    return c.json({ messages: row?.messages ?? 0, bytes: row?.bytes ?? 0, lastImportedAt: row?.last ?? null });
  });
}
