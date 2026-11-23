import PostalMime from 'postal-mime';
import { isSection, sectionOf } from './section';
import { BODY_CAP, type Env, baseSubject, domainOf, htmlToText, newId, normaliseEmail, parseAuthResults, parseIds, snippetOf, toPeople } from './util';

export interface Inbound {
  bytes: ArrayBuffer;
  envelopeFrom: string;
  envelopeTo: string;
  receivedAt?: number;
}

export type ReceiveResult =
  | { outcome: 'rejected'; reason: string }
  | { outcome: 'stored'; id: string; rawKey: string; indexed: boolean; threadId?: string; error?: string };

interface Target {
  addressId: string;
  mailboxId: string;
}

/** R2 key for a raw message. The hour is in the path so the sweep can list one small prefix. */
export function rawKeyFor(id: string, at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `raw/${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${p(d.getUTCHours())}/${id}.eml`;
}

/** "name+tag@example.com" is delivered to "name@example.com". */
function withoutTag(email: string): string {
  const at = email.lastIndexOf('@');
  const plus = email.indexOf('+');
  return plus > 0 && plus < at ? email.slice(0, plus) + email.slice(at) : email;
}

/**
 * Find where mail for this recipient goes. Returns null when Sadi Mail should refuse it.
 * With `create`, an unseen address on a known catch-all domain (or any domain, when
 * UNKNOWN_RECIPIENT is "create") is added on the spot, so a new alias works the moment it is used.
 */
export async function resolveTarget(env: Env, recipient: string, create: boolean): Promise<Target | null> {
  const email = withoutTag(normaliseEmail(recipient));
  const known = await env.DB.prepare('SELECT id, mailbox_id FROM address WHERE email = ?').bind(email).first<{ id: string; mailbox_id: string }>();
  if (known) return { addressId: known.id, mailboxId: known.mailbox_id };

  const domainName = domainOf(email);
  const domain = await env.DB.prepare('SELECT id, mailbox_id, catch_all FROM domain WHERE name = ?')
    .bind(domainName)
    .first<{ id: string; mailbox_id: string; catch_all: number }>();
  const now = Date.now();

  if (domain) {
    if (!domain.catch_all) return null;
    if (!create) return { addressId: '', mailboxId: domain.mailbox_id };
    const addressId = newId();
    await env.DB.prepare('INSERT OR IGNORE INTO address (id, mailbox_id, email, discovered, created_at) VALUES (?, ?, ?, 1, ?)')
      .bind(addressId, domain.mailbox_id, email, now)
      .run();
    const row = await env.DB.prepare('SELECT id FROM address WHERE email = ?').bind(email).first<{ id: string }>();
    return { addressId: row!.id, mailboxId: domain.mailbox_id };
  }

  if (env.UNKNOWN_RECIPIENT !== 'create') return null;
  if (!create) return { addressId: '', mailboxId: '' };

  const mailboxId = newId();
  const addressId = newId();
  const label = domainName.split('.')[0] ?? domainName;
  const position = (await env.DB.prepare('SELECT COUNT(*) AS n FROM mailbox').first<{ n: number }>())?.n ?? 0;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO mailbox (id, name, position, created_at) VALUES (?, ?, ?, ?)').bind(mailboxId, label.charAt(0).toUpperCase() + label.slice(1), position, now),
    env.DB.prepare('INSERT INTO domain (id, name, mailbox_id, catch_all, created_at) VALUES (?, ?, ?, 1, ?)').bind(newId(), domainName, mailboxId, now),
    env.DB.prepare('INSERT INTO address (id, mailbox_id, email, is_default, discovered, created_at) VALUES (?, ?, ?, 1, 1, ?)').bind(addressId, mailboxId, email, now),
  ]);
  return { addressId, mailboxId };
}

/**
 * Take one inbound message.
 *
 * Order matters: the raw bytes go to R2 before anything else is attempted, and a failure there
 * throws so the message is never reported as accepted. Once the bytes are safe, a failure to
 * index is logged and left for the sweep, which rebuilds the index entry from R2.
 */
export async function receive(env: Env, inbound: Inbound): Promise<ReceiveResult> {
  const receivedAt = inbound.receivedAt ?? Date.now();

  let refuse = false;
  try {
    refuse = (await resolveTarget(env, inbound.envelopeTo, false)) === null;
  } catch {
    // The database is unreachable. Keep the mail; the sweep will index it later.
  }
  if (refuse) return { outcome: 'rejected', reason: 'Address not found' };

  const id = newId(receivedAt);
  const rawKey = rawKeyFor(id, receivedAt);
  const t0 = Date.now();
  await env.MAIL.put(rawKey, inbound.bytes, {
    customMetadata: { from: inbound.envelopeFrom, to: inbound.envelopeTo, receivedAt: String(receivedAt) },
  });
  const storeMs = Date.now() - t0;

  try {
    const threadId = await indexMessage(env, { id, rawKey, storeMs, ...inbound, receivedAt });
    return { outcome: 'stored', id, rawKey, indexed: true, threadId };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ at: 'ingest.index', id, rawKey, error }));
    return { outcome: 'stored', id, rawKey, indexed: false, error };
  }
}

interface IndexInput extends Inbound {
  id: string;
  rawKey: string;
  receivedAt: number;
  storeMs?: number;
}

/** Parse a stored message and write its index rows. Safe to call again for the same raw key. */
export async function indexMessage(env: Env, input: IndexInput): Promise<string> {
  const { id, rawKey, receivedAt } = input;
  const existing = await env.DB.prepare('SELECT thread_id FROM message WHERE raw_key = ?').bind(rawKey).first<{ thread_id: string }>();
  if (existing) return existing.thread_id;

  const t0 = Date.now();
  const mail = await PostalMime.parse(input.bytes);
  const parseMs = Date.now() - t0;

  const target = await resolveTarget(env, input.envelopeTo, true);
  if (!target) throw new Error(`No mailbox for ${input.envelopeTo}`);

  const header = (name: string) => mail.headers.find((h) => h.key === name)?.value ?? null;
  const auth = parseAuthResults(header('authentication-results'));
  const fromEmail = normaliseEmail(mail.from?.address ?? input.envelopeFrom);
  const fromName = mail.from?.name ?? '';
  const to = toPeople(mail.to);
  const cc = toPeople(mail.cc);
  const subject = (mail.subject ?? '').trim() || '(No subject)';
  const fullText = mail.text?.trim() ? mail.text : mail.html ? htmlToText(mail.html) : '';
  const text = fullText.slice(0, BODY_CAP);
  const html = mail.html ? mail.html.slice(0, BODY_CAP) : null;
  const truncated = fullText.length > BODY_CAP || (mail.html?.length ?? 0) > BODY_CAP;
  const snippet = snippetOf(text);
  const messageId = parseIds(mail.messageId)[0] ?? null;
  const inReplyTo = parseIds(mail.inReplyTo)[0] ?? null;
  const refs = [...new Set([...parseIds(mail.references), ...(inReplyTo ? [inReplyTo] : [])])].slice(-20);
  const files = mail.attachments ?? [];
  const realFiles = files.filter((f) => !(f.related || f.disposition === 'inline'));
  // Newsletters and automated mail are not waiting for an answer.
  const bulk =
    header('list-unsubscribe') !== null || header('list-id') !== null || /^(bulk|list|junk)$/i.test(header('precedence') ?? '') ||
    /^(auto-generated|auto-replied)/i.test(header('auto-submitted') ?? '') || /^(no-?reply|do-?not-?reply|notifications?|mailer-daemon|newsletter)@/i.test(fromEmail)
      ? 1
      : 0;

  // Thread by the reply headers, within the same mailbox.
  let threadId: string | null = null;
  if (refs.length > 0) {
    const marks = refs.map(() => '?').join(',');
    const hit = await env.DB.prepare(`SELECT thread_id FROM message WHERE mailbox_id = ? AND message_id IN (${marks}) ORDER BY at DESC LIMIT 1`)
      .bind(target.mailboxId, ...refs)
      .first<{ thread_id: string }>();
    threadId = hit?.thread_id ?? null;
  }

  // Spam filter. A sender you blocked goes to Spam; a sender you cleared never does; otherwise mail
  // that fails both SPF and DMARC is treated as forged. Everything else is left for you and your rules.
  const verdict = (await env.DB.prepare('SELECT verdict FROM sender_rule WHERE email = ?').bind(fromEmail).first<{ verdict: string }>())?.verdict;
  const isSpam = verdict === 'block' || (verdict !== 'allow' && auth.dmarc === 'fail' && auth.spf === 'fail');
  const spamReason = verdict === 'block' ? 'You blocked this sender' : 'Failed SPF and DMARC';

  // Inbox section: where you last put this sender wins; otherwise it is read from the message itself.
  const learned = (await env.DB.prepare('SELECT section FROM sender_section WHERE email = ?').bind(fromEmail).first<{ section: string }>())?.section;
  const section = isSection(learned) ? learned : sectionOf({ fromEmail, subject, header });

  const statements: D1PreparedStatement[] = [];
  const dmarcFailed = auth.dmarc === 'fail' ? 1 : 0;
  const hasFiles = realFiles.length > 0 ? 1 : 0;

  if (threadId) {
    statements.push(
      env.DB.prepare(
        `UPDATE thread SET last_at = ?, last_from_name = ?, last_from_email = ?, snippet = ?, message_count = message_count + 1,
           unread_count = unread_count + 1, has_attachment = MAX(has_attachment, ?), has_inbound = 1,
           flagged_auth = MAX(flagged_auth, ?), is_bulk = ?, follow_up = 0, folder = CASE WHEN folder = 'archive' THEN 'inbox' ELSE folder END, snoozed_until = NULL
         WHERE id = ?`,
      ).bind(receivedAt, fromName, fromEmail, snippet, hasFiles, dmarcFailed, bulk, threadId),
    );
  } else {
    threadId = newId(receivedAt);
    statements.push(
      env.DB.prepare(
        `INSERT INTO thread (id, mailbox_id, address_id, subject, folder, last_at, last_from_name, last_from_email, snippet,
           message_count, unread_count, has_attachment, has_inbound, flagged_auth, is_bulk, moved_at, section)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, 1, ?, ?, ?, ?)`,
      ).bind(threadId, target.mailboxId, target.addressId, baseSubject(subject) || subject, isSpam ? 'spam' : 'inbox', receivedAt, fromName, fromEmail, snippet, hasFiles, dmarcFailed, bulk, isSpam ? receivedAt : null, section),
    );
  }

  statements.push(
    env.DB.prepare(
      `INSERT INTO message (id, thread_id, mailbox_id, address_id, direction, status, message_id, in_reply_to, refs, from_name, from_email,
         to_json, cc_json, subject, snippet, body_text, body_html, body_truncated, at, size, raw_key, unread, spf, dkim, dmarc)
       VALUES (?, ?, ?, ?, 'in', 'received', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    ).bind(
      id, threadId, target.mailboxId, target.addressId, messageId, inReplyTo, refs.join(' '), fromName, fromEmail,
      JSON.stringify(to), JSON.stringify(cc), subject, snippet, text, html, truncated ? 1 : 0, receivedAt,
      input.bytes.byteLength, rawKey, auth.spf, auth.dkim, auth.dmarc,
    ),
    env.DB.prepare('INSERT INTO message_fts (rowid, subject, sender, recipients, body) SELECT rowid, ?, ?, ?, ? FROM message WHERE id = ?').bind(
      subject,
      `${fromName} ${fromEmail}`,
      [...to, ...cc].map((p) => `${p.name} ${p.email}`).join(' '),
      text.slice(0, 64 * 1024),
      id,
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

  const authText = auth.dmarc === 'fail' ? 'DMARC failed' : auth.dmarc === 'pass' ? 'SPF, DKIM and DMARC checked' : 'No authentication result';
  const event = (kind: string, detail: string, ms: number | null) =>
    env.DB.prepare('INSERT INTO message_event (id, message_id, at, kind, detail, ms) VALUES (?, ?, ?, ?, ?, ?)').bind(newId(), id, Date.now(), kind, detail, ms);
  statements.push(
    event('accepted', `${input.envelopeFrom} → ${input.envelopeTo} · ${authText}`, null),
    event('stored', `R2 · ${rawKey}`, input.storeMs ?? null),
    event('parsed', `${files.length} attachment${files.length === 1 ? '' : 's'} · ${input.bytes.byteLength} bytes`, parseMs),
  );
  if (isSpam) statements.push(event('spam', `Filed in Spam: ${spamReason}`, null));

  const t1 = Date.now();
  await env.DB.batch(statements);
  await event('indexed', 'D1 · message, thread, search', Date.now() - t1).run();
  return threadId;
}

/**
 * Index anything that reached R2 but not D1. Looks at the current and previous hour only,
 * so each run lists a handful of objects however large the mailbox grows.
 */
export async function sweepUnindexed(env: Env, now: number = Date.now()): Promise<number> {
  let repaired = 0;
  for (const at of [now, now - 3_600_000]) {
    const prefix = rawKeyFor('', at).replace(/\.eml$/, '');
    const listing = await env.MAIL.list({ prefix, include: ['customMetadata'], limit: 500 });
    for (const object of listing.objects) {
      if (now - object.uploaded.getTime() < 60_000) continue; // still being indexed by the receiver
      const found = await env.DB.prepare('SELECT 1 AS x FROM message WHERE raw_key = ?').bind(object.key).first();
      if (found) continue;
      const body = await env.MAIL.get(object.key);
      const meta = object.customMetadata ?? {};
      if (!body || !meta.to) continue;
      const id = object.key.slice(object.key.lastIndexOf('/') + 1, -4);
      await indexMessage(env, {
        id,
        rawKey: object.key,
        bytes: await body.arrayBuffer(),
        envelopeFrom: meta.from ?? '',
        envelopeTo: meta.to,
        receivedAt: Number(meta.receivedAt) || object.uploaded.getTime(),
      });
      repaired++;
    }
  }
  return repaired;
}
