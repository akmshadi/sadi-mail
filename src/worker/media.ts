// Pictures for designed emails, and each mailbox's company header and footer.
import type { Hono } from 'hono';
import { parseLetterhead } from '../shared/design';
import { HttpError, type Principal, audit, isAdmin } from './auth';
import type { Env } from './util';

type App = Hono<{ Bindings: Env; Variables: { principal: Principal } }>;

const TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX = 2 * 1024 * 1024;

/**
 * A picture at its public address. No sign-in: whoever receives the email has to be able to load it.
 * The id is 32 random hex characters, so an address cannot be guessed, only followed from a message.
 */
export async function serveMedia(env: Env, pathname: string): Promise<Response> {
  const id = /^\/media\/([a-f0-9]{32})\.(png|jpg|webp|gif)$/.exec(pathname)?.[1];
  const row = id ? await env.DB.prepare('SELECT r2_key, mime FROM media WHERE id = ?').bind(id).first<{ r2_key: string; mime: string }>().catch(() => null) : null;
  const object = row ? await env.MAIL.get(row.r2_key) : null;
  if (!row || !object || !TYPES[row.mime]) return new Response('Not found', { status: 404 });
  return new Response(object.body, {
    headers: { 'Content-Type': row.mime, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' },
  });
}

export function registerMedia(api: App): void {
  api.put('/media', async (c) => {
    const p = c.var.principal;
    if (p.role === 'viewer') throw new HttpError(403, 'forbidden', 'Viewers cannot upload pictures.');
    const mime = (c.req.header('content-type') ?? '').split(';')[0]!.trim();
    const ext = TYPES[mime];
    if (!ext) throw new HttpError(422, 'bad_image', 'Use a PNG, JPEG, WebP or GIF picture.');
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength === 0) throw new HttpError(422, 'empty', 'That file is empty.');
    if (bytes.byteLength > MAX) throw new HttpError(422, 'too_large', 'The picture must be under 2 MB. Large pictures make an email slow to open.');
    const id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const key = `media/${id}.${ext}`;
    await c.env.MAIL.put(key, bytes, { httpMetadata: { contentType: mime } });
    const name = decodeURIComponent(c.req.header('x-file-name') ?? '').replace(/[\r\n]/g, ' ').slice(0, 120);
    await c.env.DB.prepare('INSERT INTO media (id, user_id, r2_key, mime, bytes, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, p.userId, key, mime, bytes.byteLength, name, Date.now()).run();
    return c.json({ id, url: `${new URL(c.req.url).origin}/media/${id}.${ext}`, bytes: bytes.byteLength });
  });

  api.delete('/media/:id', async (c) => {
    const p = c.var.principal;
    const row = await c.env.DB.prepare('SELECT id, user_id, r2_key FROM media WHERE id = ?').bind(c.req.param('id')).first<{ id: string; user_id: string; r2_key: string }>();
    if (!row || (!isAdmin(p) && row.user_id !== p.userId)) throw new HttpError(404, 'not_found', 'Picture not found.');
    await c.env.MAIL.delete(row.r2_key);
    await c.env.DB.prepare('DELETE FROM media WHERE id = ?').bind(row.id).run();
    return c.json({ ok: true });
  });

  api.patch('/mailboxes/:id/letterhead', async (c) => {
    const p = c.var.principal;
    if (!isAdmin(p)) throw new HttpError(403, 'forbidden', 'Only an owner or admin can change the company header and footer.');
    const row = await c.env.DB.prepare('SELECT id FROM mailbox WHERE id = ?').bind(c.req.param('id')).first<{ id: string }>();
    if (!row) throw new HttpError(404, 'not_found', 'Mailbox not found.');
    const letterhead = parseLetterhead(await c.req.json().catch(() => null));
    await c.env.DB.prepare('UPDATE mailbox SET letterhead_json = ? WHERE id = ?').bind(JSON.stringify(letterhead), row.id).run();
    await audit(c.env, p, 'mailbox.letterhead', row.id);
    return c.json({ letterhead });
  });
}
