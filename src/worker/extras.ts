import type { Hono } from 'hono';
import { designToText, parseDesign } from '../shared/design';
import type { AttachmentInfo, DraftDetail, DraftInput, LabelInfo, Person, TemplateInfo } from '../shared/types';
import { HttpError, type Principal, assertCan, audit, can, isAdmin, mailboxScope } from './auth';
import { type Env, newId, normaliseEmail, snippetOf } from './util';

type App = Hono<{ Bindings: Env; Variables: { principal: Principal } }>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_FILE = 10 * 1024 * 1024;
const MAX_TOTAL = 24 * 1024 * 1024; // Cloudflare caps a whole message at 25 MiB
const MAX_DESIGN = 200 * 1024;

/** A design sent by the compose page: checked and rewritten in its normal form, or refused. Absent means none. */
function designOf(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new HttpError(422, 'bad_design', 'The email design could not be read.');
  if (value.length > MAX_DESIGN) throw new HttpError(422, 'bad_design', 'The email design is too large.');
  const design = parseDesign(value);
  if (!design) throw new HttpError(422, 'bad_design', 'The email design could not be read.');
  return design;
}

/** People typed into a draft. Unfinished addresses are kept out rather than refused: it is only a draft. */
const people = (list: unknown): Person[] =>
  (Array.isArray(list) ? list : [])
    .map((p) => ({ name: String((p as Person)?.name ?? '').trim().slice(0, 120), email: normaliseEmail(String((p as Person)?.email ?? '')) }))
    .filter((p) => EMAIL.test(p.email))
    .slice(0, 50);

interface DraftRow {
  id: string; thread_id: string; mailbox_id: string; address_id: string; to_json: string; cc_json: string; subject: string; body_text: string;
  body_html: string | null; reply_to_id: string | null; compose_mode: string | null; at: number; created_by: string | null; design_json: string | null;
}

async function loadDraft(env: Env, p: Principal, id: string): Promise<DraftRow> {
  const row = await env.DB.prepare(
    "SELECT id, thread_id, mailbox_id, address_id, to_json, cc_json, subject, body_text, body_html, reply_to_id, compose_mode, at, created_by, design_json FROM message WHERE id = ? AND status = 'draft'",
  ).bind(id).first<DraftRow>();
  if (!row || !can(p, row.mailbox_id, 'read')) throw new HttpError(404, 'not_found', 'Draft not found.');
  return row;
}

async function filesOf(env: Env, messageId: string): Promise<AttachmentInfo[]> {
  const rows = await env.DB.prepare('SELECT id, filename, mime, size, inline FROM attachment WHERE message_id = ? ORDER BY id').bind(messageId).all<{ id: string; filename: string; mime: string; size: number; inline: number }>();
  return rows.results.map((a) => ({ id: a.id, filename: a.filename, mime: a.mime, size: a.size, inline: !!a.inline }));
}

/**
 * Forwarding a message sends its files too. Each file is copied, so the new message owns its own:
 * removing one from the draft, or deleting the draft, never touches the original.
 */
async function carryFiles(env: Env, fromMessageId: string, draftId: string): Promise<AttachmentInfo[]> {
  const rows = await env.DB.prepare('SELECT filename, mime, size, r2_key FROM attachment WHERE message_id = ? AND inline = 0 ORDER BY id').bind(fromMessageId).all<{ filename: string; mime: string; size: number; r2_key: string }>();
  const carried: AttachmentInfo[] = [];
  let total = 0;
  for (const f of rows.results) {
    if (f.size > MAX_FILE || total + f.size > MAX_TOTAL) continue;
    const object = await env.MAIL.get(f.r2_key);
    if (!object) continue;
    const id = newId();
    const key = `att/${draftId}/${id}`;
    await env.MAIL.put(key, await object.arrayBuffer(), { httpMetadata: { contentType: f.mime } });
    await env.DB.prepare('INSERT INTO attachment (id, message_id, filename, mime, size, inline, r2_key) VALUES (?, ?, ?, ?, ?, 0, ?)').bind(id, draftId, f.filename, f.mime, f.size, key).run();
    total += f.size;
    carried.push({ id, filename: f.filename, mime: f.mime, size: f.size, inline: false });
  }
  return carried;
}

export function registerExtras(api: App): void {
  // ---------- drafts ----------

  /** Create or update a draft. Called by the compose page a moment after the person stops typing. */
  api.post('/drafts', async (c) => {
    const p = c.var.principal;
    const body = await c.req.json<DraftInput>().catch(() => null);
    if (!body || typeof body.fromAddressId !== 'string') throw new HttpError(400, 'bad_request', 'A From address is required.');
    const address = await c.env.DB.prepare('SELECT id, mailbox_id, email, display_name FROM address WHERE id = ?').bind(body.fromAddressId).first<{ id: string; mailbox_id: string; email: string; display_name: string }>();
    if (!address) throw new HttpError(404, 'not_found', 'That From address does not exist.');
    assertCan(p, address.mailbox_id, 'send');

    const now = Date.now();
    const to = people(body.to);
    const copies = [...people(body.cc), ...people(body.bcc).map((x) => ({ ...x, bcc: true }))];
    const subject = String(body.subject ?? '').slice(0, 500);
    const text = String(body.text ?? '').slice(0, 256 * 1024);
    const html = typeof body.html === 'string' ? body.html.slice(0, 256 * 1024) : null;
    const mode = ['new', 'reply', 'replyAll', 'forward'].includes(body.mode) ? body.mode : 'new';
    const parsed = designOf(body.design);
    const design = parsed ? JSON.stringify(parsed) : null;
    const snippet = snippetOf(text) || '(Empty Draft)';

    if (body.id) {
      const draft = await loadDraft(c.env, p, body.id);
      if (draft.mailbox_id !== address.mailbox_id) throw new HttpError(409, 'other_mailbox', 'A draft cannot move to an address in another mailbox. Start a new message from that address.');
      await c.env.DB.batch([
        c.env.DB.prepare('UPDATE message SET address_id = ?, from_name = ?, from_email = ?, to_json = ?, cc_json = ?, subject = ?, snippet = ?, body_text = ?, body_html = ?, design_json = ?, at = ? WHERE id = ?')
          .bind(address.id, address.display_name, address.email, JSON.stringify(to), JSON.stringify(copies), subject, snippet, text, html, design, now, draft.id),
        // A draft for a new message owns its conversation row; keep that row's heading current so Drafts lists it properly.
        c.env.DB.prepare('UPDATE thread SET subject = ?, snippet = ?, last_at = ?, address_id = ? WHERE id = ? AND has_inbound = 0 AND has_outbound = 0').bind(subject || '(No Subject)', snippet, now, address.id, draft.thread_id),
      ]);
      return c.json({ id: draft.id, threadId: draft.thread_id, savedAt: now });
    }

    let threadId: string | null = null;
    let inReplyTo: string | null = null;
    let refs = '';
    let replyToId: string | null = null;
    if (body.inReplyToMessageId) {
      const original = await c.env.DB.prepare('SELECT id, thread_id, mailbox_id, message_id, refs FROM message WHERE id = ?').bind(body.inReplyToMessageId).first<{ id: string; thread_id: string; mailbox_id: string; message_id: string | null; refs: string }>();
      if (!original || original.mailbox_id !== address.mailbox_id) throw new HttpError(404, 'not_found', 'The message being answered was not found.');
      replyToId = original.id;
      if (mode !== 'forward') {
        threadId = original.thread_id;
        inReplyTo = original.message_id;
        refs = [...original.refs.split(' ').filter(Boolean), ...(original.message_id ? [original.message_id] : [])].slice(-20).join(' ');
      }
    }
    const id = newId(now);
    const statements: D1PreparedStatement[] = [];
    if (!threadId) {
      threadId = newId(now);
      statements.push(
        c.env.DB.prepare("INSERT INTO thread (id, mailbox_id, address_id, subject, folder, last_at, last_from_name, last_from_email, snippet) VALUES (?, ?, ?, ?, 'inbox', ?, 'Draft', ?, ?)")
          .bind(threadId, address.mailbox_id, address.id, subject || '(No Subject)', now, address.email, snippet),
      );
    }
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO message (id, thread_id, mailbox_id, address_id, direction, status, in_reply_to, refs, from_name, from_email, to_json, cc_json, subject, snippet,
           body_text, body_html, at, size, created_by, reply_to_id, compose_mode, design_json)
         VALUES (?, ?, ?, ?, 'out', 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      ).bind(id, threadId, address.mailbox_id, address.id, inReplyTo, refs, address.display_name, address.email, JSON.stringify(to), JSON.stringify(copies), subject, snippet, text, html, now, p.userId, replyToId, mode, design),
    );
    await c.env.DB.batch(statements);
    const attachments = mode === 'forward' && replyToId ? await carryFiles(c.env, replyToId, id) : [];
    return c.json({ id, threadId, savedAt: now, ...(attachments.length ? { attachments } : {}) });
  });

  api.get('/drafts/:id', async (c) => {
    const p = c.var.principal;
    const d = await loadDraft(c.env, p, c.req.param('id'));
    const copies = JSON.parse(d.cc_json) as (Person & { bcc?: boolean })[];
    const body: DraftDetail = {
      id: d.id, threadId: d.thread_id, fromAddressId: d.address_id, to: JSON.parse(d.to_json) as Person[],
      cc: copies.filter((x) => !x.bcc).map(({ name, email }) => ({ name, email })), bcc: copies.filter((x) => x.bcc).map(({ name, email }) => ({ name, email })),
      subject: d.subject, text: d.body_text, html: d.body_html ?? undefined, inReplyToMessageId: d.reply_to_id ?? undefined,
      mode: (d.compose_mode as DraftDetail['mode']) ?? 'new', savedAt: d.at, attachments: await filesOf(c.env, d.id),
      ...(d.design_json ? { design: d.design_json } : {}),
    };
    return c.json(body);
  });

  api.delete('/drafts/:id', async (c) => {
    const p = c.var.principal;
    const d = await loadDraft(c.env, p, c.req.param('id'));
    assertCan(p, d.mailbox_id, 'send');
    const files = await c.env.DB.prepare('SELECT r2_key FROM attachment WHERE message_id = ?').bind(d.id).all<{ r2_key: string }>();
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM attachment WHERE message_id = ?').bind(d.id),
      c.env.DB.prepare('DELETE FROM message WHERE id = ?').bind(d.id),
      // Remove the conversation row too when the draft was all it held.
      c.env.DB.prepare('DELETE FROM thread WHERE id = ? AND has_inbound = 0 AND has_outbound = 0 AND NOT EXISTS (SELECT 1 FROM message WHERE thread_id = ?)').bind(d.thread_id, d.thread_id),
    ]);
    if (files.results.length) await c.env.MAIL.delete(files.results.map((f) => f.r2_key));
    return c.json({ ok: true });
  });

  /** Attach a file to a draft. The body is the file itself. */
  api.put('/drafts/:id/attachments', async (c) => {
    const p = c.var.principal;
    const d = await loadDraft(c.env, p, c.req.param('id'));
    assertCan(p, d.mailbox_id, 'send');
    const filename = (c.req.query('filename') ?? '').replace(/[\\/\u0000-\u001f]/g, '_').trim().slice(0, 200);
    if (!filename) throw new HttpError(422, 'no_name', 'The file needs a name.');
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength === 0) throw new HttpError(422, 'empty_file', 'That file is empty.');
    if (bytes.byteLength > MAX_FILE) throw new HttpError(422, 'file_too_large', 'Each attachment can be at most 10 MB.');
    const used = (await c.env.DB.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM attachment WHERE message_id = ?').bind(d.id).first<{ n: number }>())?.n ?? 0;
    if (used + bytes.byteLength > MAX_TOTAL) throw new HttpError(422, 'message_too_large', 'Attachments on one message can total at most 24 MB.');
    const id = newId();
    const key = `att/${d.id}/${id}`;
    const mime = (c.req.header('content-type') ?? 'application/octet-stream').split(';')[0]!.trim().slice(0, 120) || 'application/octet-stream';
    await c.env.MAIL.put(key, bytes, { httpMetadata: { contentType: mime } });
    await c.env.DB.prepare('INSERT INTO attachment (id, message_id, filename, mime, size, inline, r2_key) VALUES (?, ?, ?, ?, ?, 0, ?)').bind(id, d.id, filename, mime, bytes.byteLength, key).run();
    const info: AttachmentInfo = { id, filename, mime, size: bytes.byteLength, inline: false };
    return c.json(info);
  });

  api.delete('/drafts/:id/attachments/:fileId', async (c) => {
    const p = c.var.principal;
    const d = await loadDraft(c.env, p, c.req.param('id'));
    assertCan(p, d.mailbox_id, 'send');
    const file = await c.env.DB.prepare('SELECT r2_key FROM attachment WHERE id = ? AND message_id = ?').bind(c.req.param('fileId'), d.id).first<{ r2_key: string }>();
    if (!file) throw new HttpError(404, 'not_found', 'File not found.');
    await c.env.DB.prepare('DELETE FROM attachment WHERE id = ?').bind(c.req.param('fileId')).run();
    await c.env.MAIL.delete(file.r2_key);
    return c.json({ ok: true });
  });

  // ---------- undo send ----------

  /** Take back a message that is still waiting (undo send, or a scheduled message). It becomes a draft again. */
  api.post('/messages/:id/cancel', async (c) => {
    const p = c.var.principal;
    const row = await c.env.DB.prepare('SELECT id, mailbox_id, status FROM message WHERE id = ?').bind(c.req.param('id')).first<{ id: string; mailbox_id: string; status: string }>();
    if (!row || !can(p, row.mailbox_id, 'read')) throw new HttpError(404, 'not_found', 'Message not found.');
    assertCan(p, row.mailbox_id, 'send');
    // Only wins if the sender has not claimed it yet; the same guard the sender uses.
    const claim = await c.env.DB.prepare("UPDATE message SET status = 'draft', scheduled_for = NULL WHERE id = ? AND status = 'scheduled' AND scheduled_for IS NOT NULL").bind(row.id).run();
    if (!claim.meta.changes) throw new HttpError(409, 'too_late', 'This message has already been sent.');
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE thread SET message_count = MAX(message_count - 1, 0), has_outbound = EXISTS (SELECT 1 FROM message m WHERE m.thread_id = thread.id AND m.direction = 'out' AND m.status != 'draft') WHERE id = (SELECT thread_id FROM message WHERE id = ?)").bind(row.id),
      c.env.DB.prepare("INSERT INTO message_event (id, message_id, at, kind, detail) VALUES (?, ?, ?, 'cancelled', 'Taken back before sending')").bind(newId(), row.id, Date.now()),
    ]);
    await audit(c.env, p, 'message.cancel', row.id);
    return c.json({ draftId: row.id });
  });

  // ---------- labels ----------

  api.get('/labels', async (c) => {
    const rows = await c.env.DB.prepare('SELECT id, name, color FROM label ORDER BY name COLLATE NOCASE').all<LabelInfo>();
    return c.json({ data: rows.results });
  });

  api.post('/labels', async (c) => {
    const p = c.var.principal;
    if (p.role === 'viewer') throw new HttpError(403, 'forbidden', 'Viewers cannot create labels.');
    const body = await c.req.json<{ name?: string; color?: string }>().catch(() => ({}) as { name?: string; color?: string });
    const name = (body.name ?? '').trim().slice(0, 40);
    if (!name) throw new HttpError(422, 'no_name', 'Give the label a name.');
    const color = /^#[0-9a-f]{6}$/i.test(body.color ?? '') ? body.color! : '#64748B';
    const exists = await c.env.DB.prepare('SELECT id FROM label WHERE name = ? COLLATE NOCASE').bind(name).first();
    if (exists) throw new HttpError(409, 'exists', 'A label with that name already exists.');
    const id = newId();
    await c.env.DB.prepare('INSERT INTO label (id, name, color) VALUES (?, ?, ?)').bind(id, name, color).run();
    const label: LabelInfo = { id, name, color };
    return c.json(label);
  });

  api.delete('/labels/:id', async (c) => {
    const p = c.var.principal;
    if (!isAdmin(p)) throw new HttpError(403, 'forbidden', 'Only an owner or admin can delete a label.');
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM thread_label WHERE label_id = ?').bind(c.req.param('id')),
      c.env.DB.prepare('DELETE FROM label WHERE id = ?').bind(c.req.param('id')),
    ]);
    await audit(c.env, p, 'label.delete', c.req.param('id'));
    return c.json({ ok: true });
  });

  api.post('/threads/:id/labels', async (c) => {
    const p = c.var.principal;
    const body = await c.req.json<{ labelId?: string; on?: boolean }>().catch(() => ({}) as { labelId?: string; on?: boolean });
    const thread = await c.env.DB.prepare('SELECT id, mailbox_id FROM thread WHERE id = ?').bind(c.req.param('id')).first<{ id: string; mailbox_id: string }>();
    if (!thread || !can(p, thread.mailbox_id, 'read')) throw new HttpError(404, 'not_found', 'Conversation not found.');
    assertCan(p, thread.mailbox_id, 'edit');
    const label = await c.env.DB.prepare('SELECT id FROM label WHERE id = ?').bind(body.labelId ?? '').first();
    if (!label) throw new HttpError(404, 'not_found', 'Label not found.');
    await (body.on === false
      ? c.env.DB.prepare('DELETE FROM thread_label WHERE thread_id = ? AND label_id = ?')
      : c.env.DB.prepare('INSERT OR IGNORE INTO thread_label (thread_id, label_id) VALUES (?, ?)')
    ).bind(thread.id, body.labelId).run();
    const rows = await c.env.DB.prepare('SELECT l.id, l.name, l.color FROM thread_label tl JOIN label l ON l.id = tl.label_id WHERE tl.thread_id = ? ORDER BY l.name COLLATE NOCASE').bind(thread.id).all<LabelInfo>();
    return c.json({ data: rows.results });
  });

  // ---------- templates ----------

  api.get('/templates', async (c) => {
    const rows = await c.env.DB.prepare('SELECT id, name, subject, body, design_json FROM template ORDER BY name COLLATE NOCASE').all<Omit<TemplateInfo, 'design'> & { design_json: string | null }>();
    const data: TemplateInfo[] = rows.results.map(({ design_json, ...t }) => (design_json ? { ...t, design: design_json } : t));
    return c.json({ data });
  });

  api.post('/templates', async (c) => {
    const p = c.var.principal;
    if (p.role === 'viewer') throw new HttpError(403, 'forbidden', 'Viewers cannot save templates.');
    const body = await c.req.json<{ id?: string; name?: string; subject?: string; body?: string; design?: string }>().catch(() => ({}) as Record<string, never>);
    const name = (body.name ?? '').trim().slice(0, 60);
    const parsed = designOf(body.design);
    const design = parsed ? JSON.stringify(parsed) : null;
    // A designed template keeps its plain-text version as its body, so it can still be read and searched.
    const text = (parsed ? designToText(parsed) : (body.body ?? '')).slice(0, 20_000);
    if (!name) throw new HttpError(422, 'no_name', 'Give the template a name.');
    if (!text.trim() && !parsed) throw new HttpError(422, 'empty', 'The template has no text.');
    const subject = (body.subject ?? '').trim().slice(0, 300);
    const saved = (id: string): TemplateInfo => ({ id, name, subject, body: text, ...(design ? { design } : {}) });
    if (body.id) {
      const done = await c.env.DB.prepare('UPDATE template SET name = ?, subject = ?, body = ?, design_json = ? WHERE id = ?').bind(name, subject, text, design, body.id).run();
      if (!done.meta.changes) throw new HttpError(404, 'not_found', 'Template not found.');
      return c.json(saved(body.id));
    }
    const id = newId();
    await c.env.DB.prepare('INSERT INTO template (id, name, subject, body, design_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, name, subject, text, design, Date.now()).run();
    return c.json(saved(id));
  });

  api.delete('/templates/:id', async (c) => {
    const p = c.var.principal;
    if (p.role === 'viewer') throw new HttpError(403, 'forbidden', 'Viewers cannot delete templates.');
    await c.env.DB.prepare('DELETE FROM template WHERE id = ?').bind(c.req.param('id')).run();
    return c.json({ ok: true });
  });

  // ---------- contacts ----------

  /** People you have exchanged mail with, most recent first. There is no separate address book to keep up. */
  api.get('/contacts', async (c) => {
    const p = c.var.principal;
    const q = (c.req.query('q') ?? '').trim().toLowerCase().replace(/[%_\\]/g, '').slice(0, 60);
    if (q.length < 1) return c.json({ data: [] });
    const scope = mailboxScope(p, 'm.mailbox_id');
    const like = `%${q}%`;
    const rows = await c.env.DB.prepare(
      `SELECT email, MAX(name) AS name, MAX(at) AS last FROM (
         SELECT m.from_email AS email, m.from_name AS name, m.at AS at FROM message m WHERE m.direction = 'in' AND m.dmarc != 'fail'${scope.sql}
         UNION ALL
         SELECT json_extract(j.value, '$.email') AS email, json_extract(j.value, '$.name') AS name, m.at AS at
           FROM message m, json_each(m.to_json) j WHERE m.direction = 'out' AND m.status != 'draft'${scope.sql}
       ) WHERE (email LIKE ? OR name LIKE ?) AND email NOT IN (SELECT email FROM address)
       GROUP BY email ORDER BY last DESC LIMIT 8`,
    ).bind(...scope.params, ...scope.params, like, like).all<{ email: string; name: string | null }>();
    return c.json({ data: rows.results.map((r) => ({ name: r.name ?? '', email: r.email })) });
  });
}

