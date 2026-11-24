import type { Person, SendRequest, SendResult } from '../shared/types';
import { HttpError, type Principal, assertCan } from './auth';
import { sendServerFor, sendViaServer } from './servers';
import { type Env, baseSubject, domainOf, newId, normaliseEmail, snippetOf } from './util';

interface Outgoing {
  from: Person;
  to: Person[];
  cc: Person[];
  bcc: Person[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo: string | null;
  references: string[];
  attachments?: { filename: string; mime: string; key: string }[];
  replyTo?: string;
  headers?: Record<string, string>;
}

interface Delivery {
  status: 'sent' | 'dry_run';
  /** Message-ID as the outside world will see it, without angle brackets. */
  messageId: string;
  detail: string;
}

/** A transport takes a finished message and reports what happened. Add one to support another provider. */
type Transport = (env: Env, message: Outgoing, localId: string) => Promise<Delivery>;

const dryRun: Transport = async (_env, message, localId) => ({
  status: 'dry_run',
  messageId: `${localId}@${domainOf(message.from.email)}`,
  detail: 'Dry run: stored here, nothing was sent',
});

/**
 * Cloudflare Email Sending. Needs a `send_email` binding named EMAIL and an onboarded sending
 * domain. Cloudflare sets Message-ID and Date itself, so the id it returns is what we thread on.
 */
const cloudflare: Transport = async (env, message) => {
  if (!env.EMAIL) throw new HttpError(501, 'sending_not_connected', 'Cloudflare Email Sending is not connected to this Worker.');
  const headers: Record<string, string> = {};
  if (message.inReplyTo) headers['In-Reply-To'] = `<${message.inReplyTo}>`;
  if (message.references.length) headers['References'] = message.references.map((r) => `<${r}>`).join(' ');
  Object.assign(headers, message.headers ?? {});
  const result = await env.EMAIL.send({
    replyTo: message.replyTo,
    from: message.from.name ? { email: message.from.email, name: message.from.name } : message.from.email,
    to: message.to.map((p) => p.email),
    cc: message.cc.length ? message.cc.map((p) => p.email) : undefined,
    bcc: message.bcc.length ? message.bcc.map((p) => p.email) : undefined,
    subject: message.subject,
    text: message.text,
    html: message.html,
    headers: Object.keys(headers).length ? headers : undefined,
    attachments: message.attachments?.length ? await Promise.all(message.attachments.map(async (a) => ({ filename: a.filename, type: a.mime, disposition: 'attachment', content: await base64Of(env, a.key) }))) : undefined,
  });
  return { status: 'sent', messageId: result.messageId.replace(/^<|>$/g, ''), detail: 'Accepted by Cloudflare Email Sending' };
};

async function base64Of(env: Env, key: string): Promise<string> {
  const object = await env.MAIL.get(key);
  if (!object) throw new Error('An attachment is missing from storage.');
  const bytes = new Uint8Array(await object.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function transportFor(env: Env): Transport {
  return env.SEND_MODE === 'cloudflare' ? cloudflare : dryRun;
}

const formatPerson = (p: Person) => (p.name ? `"${p.name.replace(/["\\]/g, '')}" <${p.email}>` : p.email);

/** A plain RFC 5322 copy of what was sent, kept in R2 beside inbound mail. */
function toEml(message: Outgoing, messageId: string, at: number): string {
  const lines = [
    `From: ${formatPerson(message.from)}`,
    `To: ${message.to.map(formatPerson).join(', ')}`,
    ...(message.cc.length ? [`Cc: ${message.cc.map(formatPerson).join(', ')}`] : []),
    `Subject: ${message.subject}`,
    `Date: ${new Date(at).toUTCString()}`,
    `Message-ID: <${messageId}>`,
    ...(message.replyTo ? [`Reply-To: ${message.replyTo}`] : []),
    ...(message.inReplyTo ? [`In-Reply-To: <${message.inReplyTo}>`] : []),
    ...(message.references.length ? [`References: ${message.references.map((r) => `<${r}>`).join(' ')}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    message.text,
  ];
  return lines.join('\r\n');
}

function cleanPeople(list: Person[] | undefined): Person[] {
  const out: Person[] = [];
  for (const p of list ?? []) {
    const email = normaliseEmail(p.email ?? '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(422, 'invalid_recipient', `"${p.email}" is not an email address.`);
    out.push({ name: (p.name ?? '').trim(), email });
  }
  return out;
}

const HOST_HEADER = /^(List-Unsubscribe|List-Unsubscribe-Post|X-[A-Za-z0-9-]{1,60})$/i;

/** Extra headers a caller may set. Anything that could change who the message is from, or break the header block, is refused. */
function cleanHeaders(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
    if (!HOST_HEADER.test(name) || typeof value !== 'string' || value.length > 2000 || /[\r\n]/.test(value)) throw new HttpError(422, 'invalid_header', `The header "${name.slice(0, 60)}" is not allowed.`);
    out[name] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function decodeFiles(input: SendRequest['attachments']): { filename: string; mime: string; bytes: Uint8Array }[] {
  if (!Array.isArray(input) || input.length === 0) return [];
  if (input.length > 10) throw new HttpError(422, 'too_many_attachments', 'A message can carry at most 10 files.');
  let total = 0;
  return input.map((a) => {
    const filename = String(a?.filename ?? '').replace(/[\\/\r\n"]/g, '_').trim().slice(0, 200);
    if (!filename || typeof a.contentBase64 !== 'string') throw new HttpError(422, 'invalid_attachment', 'Each file needs a name and its content.');
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(a.contentBase64), (ch) => ch.charCodeAt(0));
    } catch {
      throw new HttpError(422, 'invalid_attachment', `"${filename}" is not valid base64.`);
    }
    total += bytes.byteLength;
    if (total > 10 * 1024 * 1024) throw new HttpError(422, 'attachments_too_large', 'The files are larger than 10 MB together.');
    const mime = typeof a.mime === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(a.mime) ? a.mime : 'application/octet-stream';
    return { filename, mime, bytes };
  });
}

async function keyedId(userId: string, key: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${userId}\n${key}`)));
  return 'k' + Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Queue or deliver a message written by a person. */
export async function sendMessage(env: Env, principal: Principal, request: SendRequest): Promise<SendResult> {
  const address = await (request.fromEmail && !request.fromAddressId
    ? env.DB.prepare('SELECT id, mailbox_id, email, display_name FROM address WHERE email = ?').bind(normaliseEmail(request.fromEmail))
    : env.DB.prepare('SELECT id, mailbox_id, email, display_name FROM address WHERE id = ?').bind(request.fromAddressId)
  ).first<{ id: string; mailbox_id: string; email: string; display_name: string }>();
  if (!address) throw new HttpError(404, 'not_found', 'That From address does not exist.');
  assertCan(principal, address.mailbox_id, 'send');

  const to = cleanPeople(request.to);
  const cc = cleanPeople(request.cc);
  const bcc = cleanPeople(request.bcc);
  if (to.length + cc.length + bcc.length === 0) throw new HttpError(422, 'no_recipient', 'Add at least one recipient.');
  if (to.length + cc.length + bcc.length > 50) throw new HttpError(422, 'too_many_recipients', 'A message can have at most 50 recipients.');
  const subject = (request.subject ?? '').trim() || '(No subject)';
  const text = request.text ?? '';
  if (!text.trim() && !request.html) throw new HttpError(422, 'empty', 'Write a message before sending.');

  let threadId: string | null = null;
  let inReplyTo: string | null = null;
  let references: string[] = [];
  if (request.inReplyToMessageId) {
    const original = await env.DB.prepare('SELECT thread_id, mailbox_id, message_id, refs FROM message WHERE id = ?')
      .bind(request.inReplyToMessageId)
      .first<{ thread_id: string; mailbox_id: string; message_id: string | null; refs: string }>();
    if (!original || original.mailbox_id !== address.mailbox_id) throw new HttpError(404, 'not_found', 'The message being answered was not found.');
    threadId = original.thread_id;
    inReplyTo = original.message_id;
    references = [...original.refs.split(' ').filter(Boolean), ...(original.message_id ? [original.message_id] : [])].slice(-20);
  }

  const replyTo = request.replyTo ? cleanPeople([{ name: '', email: request.replyTo }])[0]!.email : undefined;
  const headers = cleanHeaders(request.headers);
  const files = decodeFiles(request.attachments);

  const now = Date.now();
  // A caller's idempotency key becomes the message's own id, so a repeat finds the first message and sends nothing.
  const key = typeof request.idempotencyKey === 'string' ? request.idempotencyKey.trim().slice(0, 256) : '';
  const id = key ? await keyedId(principal.userId, key) : newId(now);
  if (key) {
    const first = await env.DB.prepare('SELECT thread_id, status FROM message WHERE id = ?').bind(id).first<{ thread_id: string; status: SendResult['status'] }>();
    if (first) return { messageId: id, threadId: first.thread_id, status: first.status, dryRun: first.status === 'dry_run' };
  }
  const undo = typeof request.undoSeconds === 'number' ? Math.min(30, Math.max(0, request.undoSeconds)) : 0;
  const sendAt = typeof request.scheduledFor === 'number' && request.scheduledFor > now + 5_000 ? request.scheduledFor : undo > 0 ? now + undo * 1000 : null;
  const scheduled = sendAt !== null;

  let draft: { id: string; thread_id: string; mailbox_id: string } | null = null;
  let draftOwnsThread = false;
  if (request.draftId) {
    draft = await env.DB.prepare("SELECT id, thread_id, mailbox_id FROM message WHERE id = ? AND status = 'draft'").bind(request.draftId).first();
    if (!draft || draft.mailbox_id !== address.mailbox_id) throw new HttpError(404, 'not_found', 'That draft no longer exists.');
    if (!threadId) {
      threadId = draft.thread_id;
      draftOwnsThread = true;
    }
  }
  const outgoing: Outgoing = { from: { name: address.display_name, email: address.email }, to, cc, bcc, subject, text, html: request.html, inReplyTo, references, replyTo, headers };

  const statements: D1PreparedStatement[] = [];
  const snippet = snippetOf(text);
  if (draftOwnsThread) {
    // A new message written as a draft already has its own conversation row; give it its real heading.
    statements.push(env.DB.prepare('UPDATE thread SET subject = ?, last_from_name = ?, last_from_email = ? WHERE id = ? AND has_inbound = 0').bind(baseSubject(subject) || subject, address.display_name, address.email, threadId));
  }
  if (threadId) {
    statements.push(
      env.DB.prepare('UPDATE thread SET last_at = ?, snippet = ?, message_count = message_count + 1, has_outbound = 1, follow_up = 0 WHERE id = ?').bind(now, snippet, threadId),
    );
  } else {
    threadId = newId(now);
    statements.push(
      env.DB.prepare(
        `INSERT INTO thread (id, mailbox_id, address_id, subject, folder, last_at, last_from_name, last_from_email, snippet, message_count, has_outbound)
         VALUES (?, ?, ?, ?, 'inbox', ?, ?, ?, ?, 1, 1)`,
      ).bind(threadId, address.mailbox_id, address.id, baseSubject(subject) || subject, now, address.display_name, address.email, snippet),
    );
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO message (id, thread_id, mailbox_id, address_id, direction, status, in_reply_to, refs, from_name, from_email, to_json, cc_json,
         subject, snippet, body_text, body_html, at, scheduled_for, size, created_by)
       VALUES (?, ?, ?, ?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, threadId, address.mailbox_id, address.id, scheduled ? 'scheduled' : 'draft', inReplyTo, references.join(' '), address.display_name, address.email,
      JSON.stringify(to), JSON.stringify([...cc, ...bcc.map((p) => ({ ...p, bcc: true }))]), subject, snippet, text, request.html ?? null, now,
      sendAt, text.length, principal.userId,
    ),
    env.DB.prepare('INSERT INTO message_fts (rowid, subject, sender, recipients, body) SELECT rowid, ?, ?, ?, ? FROM message WHERE id = ?').bind(
      subject, `${address.display_name} ${address.email}`, [...to, ...cc].map((p) => `${p.name} ${p.email}`).join(' '), text.slice(0, 64 * 1024), id,
    ),
  );
  if (draft) {
    statements.push(
      env.DB.prepare('UPDATE attachment SET message_id = ? WHERE message_id = ?').bind(id, draft.id),
      env.DB.prepare('UPDATE thread SET has_attachment = 1 WHERE id = ? AND EXISTS (SELECT 1 FROM attachment WHERE message_id = ? AND inline = 0)').bind(threadId, id),
      env.DB.prepare('DELETE FROM message_fts WHERE rowid = (SELECT rowid FROM message WHERE id = ?)').bind(draft.id),
      env.DB.prepare('DELETE FROM message WHERE id = ?').bind(draft.id),
    );
  }
  for (const f of files) {
    const fileId = newId();
    const r2Key = `attachments/${id}/${fileId}`;
    await env.MAIL.put(r2Key, f.bytes, { httpMetadata: { contentType: f.mime } });
    statements.push(env.DB.prepare('INSERT INTO attachment (id, message_id, filename, mime, size, inline, r2_key) VALUES (?, ?, ?, ?, ?, 0, ?)').bind(fileId, id, f.filename, f.mime, f.bytes.byteLength, r2Key));
  }
  if (files.length) statements.push(env.DB.prepare('UPDATE thread SET has_attachment = 1 WHERE id = ?').bind(threadId));
  await env.DB.batch(statements);

  if (scheduled) {
    await logEvent(env, id, 'scheduled', undo > 0 && sendAt === now + undo * 1000 ? `Held ${undo} seconds so it can be taken back` : `Will send ${new Date(sendAt!).toISOString()}`);
    return { messageId: id, threadId, status: 'scheduled', dryRun: env.SEND_MODE !== 'cloudflare' && !(await sendServerFor(env, outgoing.from.email)) };
  }
  const status = await deliver(env, id, outgoing);
  return { messageId: id, threadId, status, dryRun: status === 'dry_run' };
}

async function logEvent(env: Env, messageId: string, kind: string, detail: string, ms: number | null = null): Promise<void> {
  await env.DB.prepare('INSERT INTO message_event (id, message_id, at, kind, detail, ms) VALUES (?, ?, ?, ?, ?, ?)').bind(newId(), messageId, Date.now(), kind, detail, ms).run();
}

/** Hand one stored message to the transport and record the outcome on its row. */
async function deliver(env: Env, id: string, outgoing: Outgoing): Promise<'sent' | 'dry_run' | 'failed'> {
  const t0 = Date.now();
  try {
    const files = await env.DB.prepare('SELECT filename, mime, r2_key AS key FROM attachment WHERE message_id = ? AND inline = 0').bind(id).all<{ filename: string; mime: string; key: string }>();
    outgoing.attachments = files.results;
    // An address with its own SMTP server sends through it; everything else goes the installation's way.
    const server = await sendServerFor(env, outgoing.from.email);
    let delivery: Delivery;
    if (server) {
      const attachments = await Promise.all(files.results.map(async (a) => ({ filename: a.filename, mime: a.mime, base64: await base64Of(env, a.key) })));
      const sent = await sendViaServer(env, server, { ...outgoing, attachments }, id);
      delivery = { status: 'sent', ...sent };
    } else {
      delivery = await transportFor(env)(env, outgoing, id);
    }
    const at = Date.now();
    const rawKey = `sent/${new Date(at).toISOString().slice(0, 7).replace('-', '/')}/${id}.eml`;
    await env.MAIL.put(rawKey, toEml(outgoing, delivery.messageId, at));
    await env.DB.prepare('UPDATE message SET status = ?, message_id = ?, raw_key = ?, at = ?, error = NULL WHERE id = ?').bind(delivery.status, delivery.messageId, rawKey, at, id).run();
    await logEvent(env, id, delivery.status === 'sent' ? 'sent' : 'dry-run', delivery.detail, at - t0);
    return delivery.status;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await env.DB.prepare("UPDATE message SET status = 'failed', error = ? WHERE id = ?").bind(error, id).run();
    await logEvent(env, id, 'failed', error, Date.now() - t0);
    if (err instanceof HttpError) throw err;
    return 'failed';
  }
}

/** Send every scheduled message whose time has come. Called by the cron trigger each minute. */
export async function deliverDue(env: Env, now: number = Date.now()): Promise<number> {
  const due = await env.DB.prepare(
    `SELECT m.id, m.from_name, m.from_email, m.to_json, m.cc_json, m.subject, m.body_text, m.body_html, m.in_reply_to, m.refs
       FROM message m WHERE m.status = 'scheduled' AND m.scheduled_for <= ? ORDER BY m.scheduled_for LIMIT 20`,
  )
    .bind(now)
    .all<{ id: string; from_name: string; from_email: string; to_json: string; cc_json: string; subject: string; body_text: string; body_html: string | null; in_reply_to: string | null; refs: string }>();
  for (const row of due.results) {
    // Claim the message first, so the cron and an undo-send timer can never both send it.
    const claim = await env.DB.prepare("UPDATE message SET scheduled_for = NULL WHERE id = ? AND status = 'scheduled' AND scheduled_for IS NOT NULL").bind(row.id).run();
    if (!claim.meta.changes) continue;
    const copies = JSON.parse(row.cc_json) as (Person & { bcc?: boolean })[];
    try {
      await deliver(env, row.id, {
        from: { name: row.from_name, email: row.from_email },
        to: JSON.parse(row.to_json) as Person[],
        cc: copies.filter((p) => !p.bcc),
        bcc: copies.filter((p) => p.bcc),
        subject: row.subject,
        text: row.body_text,
        html: row.body_html ?? undefined,
        inReplyTo: row.in_reply_to,
        references: row.refs.split(' ').filter(Boolean),
      });
    } catch {
      // Already recorded on the message as failed.
    }
  }
  return due.results.length;
}
