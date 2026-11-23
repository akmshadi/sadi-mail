import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import type { Role } from '../shared/types';
import { type Env, newId } from './util';

export type Action = 'read' | 'send' | 'edit' | 'delete';

interface Grant {
  read: boolean;
  send: boolean;
  edit: boolean;
  delete: boolean;
}

export interface Principal {
  userId: string;
  name: string;
  role: Role;
  /** Mailboxes this person holds a grant on. Owners and admins are not limited by it. */
  grants: Map<string, Grant>;
}

export class HttpError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 422 | 501,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const isAdmin = (p: Principal) => p.role === 'owner' || p.role === 'admin';

export function can(p: Principal, mailboxId: string, action: Action): boolean {
  if (isAdmin(p)) return true;
  const grant = p.grants.get(mailboxId);
  if (!grant || !grant.read) return false;
  if (p.role === 'viewer') return action === 'read';
  return grant[action];
}

/** A mailbox the person cannot read does not exist as far as they can tell. */
export function assertCan(p: Principal, mailboxId: string, action: Action): void {
  if (can(p, mailboxId, 'read') && !can(p, mailboxId, action)) {
    throw new HttpError(403, 'forbidden', `You do not have permission to ${action} in this mailbox.`);
  }
  if (!can(p, mailboxId, action)) throw new HttpError(404, 'not_found', 'Not found.');
}

/** SQL fragment limiting a query to readable mailboxes. */
export function mailboxScope(p: Principal, column: string): { sql: string; params: string[] } {
  if (isAdmin(p)) return { sql: '', params: [] };
  const ids = [...p.grants.entries()].filter(([, g]) => g.read).map(([id]) => id);
  if (ids.length === 0) return { sql: ' AND 0', params: [] };
  return { sql: ` AND ${column} IN (${ids.map(() => '?').join(',')})`, params: ids };
}

async function loadPrincipal(env: Env, subject: string, name: string, roleForNew: Role): Promise<Principal> {
  let user = await env.DB.prepare('SELECT id, name, role, status FROM user WHERE subject = ?').bind(subject).first<{ id: string; name: string; role: Role; status: string }>();
  if (!user) {
    // The first person to sign in to a new installation owns it.
    const count = (await env.DB.prepare('SELECT COUNT(*) AS n FROM user').first<{ n: number }>())?.n ?? 0;
    const role: Role = count === 0 ? 'owner' : roleForNew;
    const id = newId();
    await env.DB.prepare('INSERT OR IGNORE INTO user (id, subject, name, role, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, subject, name, role, Date.now()).run();
    user = await env.DB.prepare('SELECT id, name, role, status FROM user WHERE subject = ?').bind(subject).first();
  }
  if (!user || user.status !== 'active') throw new HttpError(403, 'disabled', 'This account is disabled.');

  const grants = new Map<string, Grant>();
  const rows = await env.DB.prepare('SELECT mailbox_id, can_read, can_send, can_edit, can_delete FROM mailbox_grant WHERE user_id = ?').bind(user.id).all<{
    mailbox_id: string;
    can_read: number;
    can_send: number;
    can_edit: number;
    can_delete: number;
  }>();
  for (const r of rows.results) grants.set(r.mailbox_id, { read: !!r.can_read, send: !!r.can_send, edit: !!r.can_edit, delete: !!r.can_delete });
  return { userId: user.id, name: user.name, role: user.role, grants };
}

let accessKeys: ReturnType<typeof createRemoteJWKSet> | null = null;

/**
 * Work out who is calling. Three ways in:
 *  1. A host application's signed token (Authorization: Bearer …), checked against HOST_PUBLIC_KEYS.
 *  2. Cloudflare Access, when AUTH_MODE is "access".
 *  3. Local development, when AUTH_MODE is "dev" and the request is to localhost.
 */
export async function authenticate(env: Env, request: Request): Promise<Principal> {
  const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
  if (bearer) {
    let keys: JSONWebKeySet['keys'] = [];
    try {
      keys = JSON.parse(env.HOST_PUBLIC_KEYS || '[]');
    } catch {
      keys = [];
    }
    if (keys.length === 0) throw new HttpError(401, 'unauthenticated', 'No host application is allowed to call this installation.');
    try {
      const { payload } = await jwtVerify(bearer, createLocalJWKSet({ keys }), { audience: 'sadi-mail', algorithms: ['EdDSA', 'ES256'], maxTokenAge: '10m' });
      if (!payload.sub || !payload.iss) throw new Error('Token needs iss and sub');
      const role = (['admin', 'member', 'viewer'] as const).find((r) => r === payload.role) ?? 'member';
      const principal = await loadPrincipal(env, `host:${payload.iss}:${payload.sub}`, typeof payload.name === 'string' ? payload.name : payload.sub, role);
      // The host application is the source of truth for who its people are. When its token names a
      // role, Sadi Mail follows it on every sign-in, so promoting or demoting someone in the host takes
      // effect at once. An owner is never changed this way.
      if (typeof payload.role === 'string' && principal.role !== 'owner' && principal.role !== role) {
        await env.DB.prepare('UPDATE user SET role = ? WHERE id = ?').bind(role, principal.userId).run();
        principal.role = role;
      }
      return principal;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(401, 'unauthenticated', 'The host token is not valid.');
    }
  }

  if (env.AUTH_MODE === 'access') {
    const token = request.headers.get('cf-access-jwt-assertion');
    if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) throw new HttpError(401, 'unauthenticated', 'Sign in through Cloudflare Access.');
    const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
    accessKeys ??= createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    try {
      const { payload } = await jwtVerify(token, accessKeys, { issuer, audience: env.ACCESS_AUD });
      const subject = typeof payload.email === 'string' ? payload.email : payload.sub;
      if (!subject) throw new Error('No identity in token');
      return await loadPrincipal(env, `access:${subject}`, subject.split('@')[0] ?? subject, 'viewer');
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(401, 'unauthenticated', 'The Cloudflare Access token is not valid.');
    }
  }

  if (env.AUTH_MODE === 'dev') {
    const host = new URL(request.url).hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost')) {
      return loadPrincipal(env, 'dev', 'You', 'owner');
    }
    throw new HttpError(401, 'unauthenticated', 'Development sign-in only works on localhost. Set AUTH_MODE to "access" before deploying.');
  }

  throw new HttpError(401, 'unauthenticated', 'Sign-in is not configured.');
}

export async function audit(env: Env, p: Principal, action: string, target = '', detail = ''): Promise<void> {
  await env.DB.prepare('INSERT INTO audit (id, at, user_id, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)').bind(newId(), Date.now(), p.userId, action, target, detail).run();
}
