// Mail servers outside Cloudflare. An installation works without any: Cloudflare receives and sends.
// This is for people who bring their own account elsewhere and want to send through its SMTP
// server, read its inbox over IMAP, or both.
import { connect } from 'cloudflare:sockets';
import type { Hono } from 'hono';
import type { MailServerInfo } from '../shared/types';
import { openKey, sealKey } from './ai';
import { HttpError, type Principal, audit, isAdmin } from './auth';
import { imapCheck, imapFetchNew } from './imap';
import { receive } from './ingest';
import { type MimeMessage, smtpCheck, smtpSend } from './smtp';
import { type Env, newId, normaliseEmail } from './util';
import type { Dial, Security, Wire } from './wire';

type App = Hono<{ Bindings: Env; Variables: { principal: Principal } }>;

interface Row {
  id: string; name: string; email: string; username: string; pass_cipher: string;
  smtp_host: string; smtp_port: number; smtp_security: Security;
  imap_host: string; imap_port: number; imap_security: Security;
  send_enabled: number; receive_enabled: number;
  imap_uidvalidity: number | null; imap_last_uid: number | null;
  last_checked_at: number | null; last_received_at: number | null; last_error: string | null; created_at: number;
}

function wrap(socket: Socket): Wire {
  return { readable: socket.readable, writable: socket.writable, startTls: () => wrap(socket.startTls()), close: () => socket.close() };
}
const realDial: Dial = (host, port, security) => wrap(connect({ hostname: host, port }, { secureTransport: security === 'tls' ? 'on' : security === 'starttls' ? 'starttls' : 'off', allowHalfOpen: false }));
let dial: Dial = realDial;
/** Tests stand in a scripted server here. */
export function setDial(next: Dial | null): void { dial = next ?? realDial; }

const info = (r: Row): MailServerInfo => ({
  id: r.id, name: r.name, email: r.email, username: r.username,
  smtpHost: r.smtp_host, smtpPort: r.smtp_port, smtpSecurity: r.smtp_security,
  imapHost: r.imap_host, imapPort: r.imap_port, imapSecurity: r.imap_security,
  sendEnabled: !!r.send_enabled, receiveEnabled: !!r.receive_enabled,
  lastCheckedAt: r.last_checked_at, lastReceivedAt: r.last_received_at, lastError: r.last_error, watching: r.imap_last_uid !== null,
});

const smtpOf = async (env: Env, r: Row) => ({ host: r.smtp_host, port: r.smtp_port, security: r.smtp_security, username: r.username, password: await openKey(env, r.pass_cipher) });
const imapOf = async (env: Env, r: Row) => ({ host: r.imap_host, port: r.imap_port, security: r.imap_security, username: r.username, password: await openKey(env, r.pass_cipher) });

/** The server that sends for this address, when one is set up and switched on. */
export async function sendServerFor(env: Env, fromEmail: string): Promise<Row | null> {
  try {
    return await env.DB.prepare("SELECT * FROM mail_server WHERE email = ? AND send_enabled = 1 AND smtp_host <> ''").bind(normaliseEmail(fromEmail)).first<Row>();
  } catch {
    return null; // the table is not there yet on an installation that has not run this migration
  }
}

export async function sendViaServer(env: Env, r: Row, message: MimeMessage, localId: string): Promise<{ messageId: string; detail: string }> {
  const messageId = `${localId}@${r.email.split('@')[1]}`;
  const answer = await smtpSend(dial, await smtpOf(env, r), message, messageId, Date.now());
  return { messageId, detail: `Accepted by ${r.smtp_host}${answer ? `: ${answer}` : ''}` };
}

/** Bring new mail in from one account. Returns how many messages were stored. */
export async function pollServer(env: Env, r: Row): Promise<number> {
  const now = Date.now();
  try {
    const result = await imapFetchNew(dial, await imapOf(env, r), { uidValidity: r.imap_uidvalidity, lastUid: r.imap_last_uid });
    let stored = 0;
    let lastUid = r.imap_last_uid !== null && !result.firstRun ? r.imap_last_uid : result.state.lastUid;
    for (const m of result.messages) {
      const out = await receive(env, { bytes: m.bytes.buffer.slice(m.bytes.byteOffset, m.bytes.byteOffset + m.bytes.byteLength) as ArrayBuffer, envelopeFrom: '', envelopeTo: r.email, receivedAt: Date.now() });
      if (out.outcome !== 'stored') throw new Error(`A message could not be stored: ${out.reason}`);
      stored++;
      lastUid = m.uid;
      // Saved after every message, so a failure part-way never brings the same mail in twice.
      await env.DB.prepare('UPDATE mail_server SET imap_uidvalidity = ?, imap_last_uid = ? WHERE id = ?').bind(result.state.uidValidity, lastUid, r.id).run();
    }
    await env.DB.prepare('UPDATE mail_server SET imap_uidvalidity = ?, imap_last_uid = ?, last_checked_at = ?, last_error = ?, last_received_at = CASE WHEN ? > 0 THEN ? ELSE last_received_at END WHERE id = ?')
      .bind(result.state.uidValidity, result.state.lastUid, now, result.skipped ? `${result.skipped} message(s) over 25 MB were left on the server.` : null, stored, now, r.id).run();
    return stored;
  } catch (err) {
    await env.DB.prepare('UPDATE mail_server SET last_checked_at = ?, last_error = ? WHERE id = ?').bind(now, (err instanceof Error ? err.message : String(err)).slice(0, 300), r.id).run();
    throw err;
  }
}

/** Called by the timer each minute: check every account that receives. One failing account never stops the others. */
export async function pollServers(env: Env): Promise<number> {
  let rows: Row[] = [];
  try {
    rows = (await env.DB.prepare("SELECT * FROM mail_server WHERE receive_enabled = 1 AND imap_host <> ''").all<Row>()).results;
  } catch {
    return 0;
  }
  const done = await Promise.allSettled(rows.map((r) => pollServer(env, r)));
  return done.reduce((n, d) => n + (d.status === 'fulfilled' ? d.value : 0), 0);
}

// ---------- settings routes (owner and admin only) ----------

const SECURITIES: Security[] = ['tls', 'starttls', 'none'];
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/i;
const cleanHost = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/:].*$/, '').slice(0, 200) : '');

function read(body: Record<string, unknown>, kind: 'smtp' | 'imap', fallbackPort: number) {
  const host = cleanHost(body[`${kind}Host`]);
  const port = Number(body[`${kind}Port`] ?? fallbackPort);
  const security = SECURITIES.includes(body[`${kind}Security`] as Security) ? (body[`${kind}Security`] as Security) : 'tls';
  if (host) {
    if (!/^[a-z0-9.-]+$|^\[::1\]$/.test(host)) throw new HttpError(422, 'bad_host', `"${host}" is not a server name.`);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(422, 'bad_port', 'A port is a number from 1 to 65535.');
    if (port === 25) throw new HttpError(422, 'port_25', 'Cloudflare does not allow connections on port 25. Use 465 (TLS) or 587 (STARTTLS).');
    // A password is never sent over an unencrypted connection, except to a test server on this machine.
    if (security === 'none' && !LOCAL.test(host)) throw new HttpError(422, 'needs_tls', 'Choose TLS or STARTTLS. An unencrypted connection would send the password in the open.');
  }
  return { host, port, security };
}

export function registerServers(api: App): void {
  const admin = (p: Principal) => { if (!isAdmin(p)) throw new HttpError(404, 'not_found', 'Not found.'); };
  const find = async (env: Env, id: string) => {
    const row = await env.DB.prepare('SELECT * FROM mail_server WHERE id = ?').bind(id).first<Row>();
    if (!row) throw new HttpError(404, 'not_found', 'Mail server not found.');
    return row;
  };

  api.get('/mail-servers', async (c) => {
    admin(c.var.principal);
    const rows = await c.env.DB.prepare('SELECT * FROM mail_server ORDER BY created_at').all<Row>();
    return c.json({ data: rows.results.map(info) });
  });

  api.post('/mail-servers', async (c) => {
    const p = c.var.principal;
    admin(p);
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    const email = normaliseEmail(String(body.email ?? ''));
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(422, 'invalid_email', 'Enter the full email address of the account.');
    const password = String(body.password ?? '');
    if (!password) throw new HttpError(422, 'no_password', 'Enter the password for the account. Many providers want an app password, not your normal one.');
    const smtp = read(body, 'smtp', 465);
    const imap = read(body, 'imap', 993);
    if (!smtp.host && !imap.host) throw new HttpError(422, 'no_server', 'Enter an SMTP server, an IMAP server, or both.');
    if (await c.env.DB.prepare('SELECT 1 AS x FROM mail_server WHERE email = ?').bind(email).first()) throw new HttpError(409, 'exists', 'A server is already set up for that address.');

    // The address has to exist in a mailbox, so its mail has somewhere to live.
    let address = await c.env.DB.prepare('SELECT id FROM address WHERE email = ?').bind(email).first<{ id: string }>();
    if (!address) {
      const mailbox = await c.env.DB.prepare('SELECT id FROM mailbox WHERE id = ?').bind(String(body.mailboxId ?? '')).first<{ id: string }>();
      if (!mailbox) throw new HttpError(422, 'no_mailbox', 'Choose the mailbox this address belongs to.');
      address = { id: newId() };
      await c.env.DB.prepare('INSERT INTO address (id, mailbox_id, email, display_name, created_at) VALUES (?, ?, ?, ?, ?)').bind(address.id, mailbox.id, email, '', Date.now()).run();
    }
    const id = newId();
    await c.env.DB.prepare(
      `INSERT INTO mail_server (id, name, email, username, pass_cipher, smtp_host, smtp_port, smtp_security, imap_host, imap_port, imap_security, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, String(body.name ?? '').trim().slice(0, 60) || email.split('@')[1], email, String(body.username ?? '').trim().slice(0, 200) || email, await sealKey(c.env, password), smtp.host, smtp.port, smtp.security, imap.host, imap.port, imap.security, Date.now()).run();
    await audit(c.env, p, 'mail_server.create', id, email);
    return c.json(info(await find(c.env, id)));
  });

  api.patch('/mail-servers/:id', async (c) => {
    const p = c.var.principal;
    admin(p);
    const row = await find(c.env, c.req.param('id'));
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    const sets: string[] = [];
    const values: unknown[] = [];
    if (typeof body.sendEnabled === 'boolean') {
      if (body.sendEnabled && !row.smtp_host) throw new HttpError(422, 'no_smtp', 'This account has no SMTP server to send through.');
      sets.push('send_enabled = ?'); values.push(body.sendEnabled ? 1 : 0);
    }
    if (typeof body.receiveEnabled === 'boolean') {
      if (body.receiveEnabled && !row.imap_host) throw new HttpError(422, 'no_imap', 'This account has no IMAP server to receive from.');
      sets.push('receive_enabled = ?'); values.push(body.receiveEnabled ? 1 : 0);
    }
    if (typeof body.password === 'string' && body.password) { sets.push('pass_cipher = ?'); values.push(await sealKey(c.env, body.password)); }
    if (sets.length) await c.env.DB.prepare(`UPDATE mail_server SET ${sets.join(', ')} WHERE id = ?`).bind(...values, row.id).run();
    await audit(c.env, p, 'mail_server.update', row.id, sets.map((s) => s.split(' ')[0]).filter((s) => s !== 'pass_cipher').join(','));
    return c.json(info(await find(c.env, row.id)));
  });

  api.delete('/mail-servers/:id', async (c) => {
    const p = c.var.principal;
    admin(p);
    const row = await find(c.env, c.req.param('id'));
    await c.env.DB.prepare('DELETE FROM mail_server WHERE id = ?').bind(row.id).run();
    await audit(c.env, p, 'mail_server.delete', row.id, row.email);
    return c.json({ ok: true });
  });

  /** Sign in to each server and report what happened. Nothing is sent and nothing is fetched. */
  api.post('/mail-servers/:id/test', async (c) => {
    admin(c.var.principal);
    const row = await find(c.env, c.req.param('id'));
    const say = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);
    const out: { smtp?: { ok: boolean; detail: string }; imap?: { ok: boolean; detail: string } } = {};
    if (row.smtp_host) {
      try { await smtpCheck(dial, await smtpOf(c.env, row)); out.smtp = { ok: true, detail: 'Signed in.' }; } catch (err) { out.smtp = { ok: false, detail: say(err) }; }
    }
    if (row.imap_host) {
      try { const r = await imapCheck(dial, await imapOf(c.env, row)); out.imap = { ok: true, detail: `Signed in. ${r.messages} message(s) in the inbox.` }; } catch (err) { out.imap = { ok: false, detail: say(err) }; }
    }
    return c.json(out);
  });

  api.post('/mail-servers/:id/check', async (c) => {
    admin(c.var.principal);
    const row = await find(c.env, c.req.param('id'));
    if (!row.imap_host) throw new HttpError(422, 'no_imap', 'This account has no IMAP server to receive from.');
    try {
      const stored = await pollServer(c.env, row);
      return c.json({ stored, server: info(await find(c.env, row.id)) });
    } catch (err) {
      throw new HttpError(409, 'check_failed', (err instanceof Error ? err.message : String(err)).slice(0, 300));
    }
  });
}
