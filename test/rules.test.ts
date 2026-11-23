import { env } from 'cloudflare:test';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
import type { LabelInfo, RuleInfo, ThreadSummary } from '../src/shared/types';
import { applyRules } from '../src/worker/rules';
import type { Env } from '../src/worker/util';
import { call, deliver, offline, post } from './helpers';

const DESK = 'desk@rules-test.example';
const OTHER = 'shop@rules-other.example';
let seq = 0;

async function arrive(o: { from?: string; subject?: string; body?: string; to?: string; attachment?: boolean } = {}) {
  const n = ++seq;
  const subject = o.subject ?? `Rules subject ${n}`;
  const r = await deliver({
    from: o.from ?? `Billing <billing${n}@vendor-${n}.example>`, to: o.to ?? DESK, subject, body: o.body ?? `Body ${n}`, messageId: `rules-${n}-${Date.now()}@sender.example`,
    attachment: o.attachment ? { filename: 'invoice.pdf', content: '%PDF-test' } : undefined,
  });
  if (r.outcome !== 'stored') throw new Error('not stored');
  return r.threadId!;
}

const state = (threadId: string) =>
  env.DB.prepare('SELECT folder, starred, unread_count, (SELECT COUNT(*) FROM message WHERE thread_id = thread.id AND unread = 1) AS unread_messages FROM thread WHERE id = ?').bind(threadId)
    .first<{ folder: string; starred: number; unread_count: number; unread_messages: number }>();
const labelsOf = async (threadId: string) =>
  (await env.DB.prepare('SELECT label_id FROM thread_label WHERE thread_id = ?').bind(threadId).all<{ label_id: string }>()).results.map((r) => r.label_id);
const mailboxOf = async (email: string) => (await env.DB.prepare('SELECT mailbox_id FROM address WHERE email = ?').bind(email).first<{ mailbox_id: string }>())!.mailbox_id;

async function label(name: string) {
  const made = await call<LabelInfo>('/api/labels', post({ name: `${name} ${++seq}`, color: '#336699' }));
  return made.body;
}
const make = (body: unknown) => call<RuleInfo & { error?: string }>('/api/rules', post(body));

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM rule').run();
});

describe('applying rules to new mail', () => {
  it('labels and marks read what matches, and leaves the rest alone', async () => {
    await arrive();
    const tag = await label('Invoice');
    const made = await make({ name: 'Invoices', match: { from: 'INVOICE@acme' }, action: { labelId: tag.id, markRead: true } });
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ name: 'Invoices', enabled: true, mailboxId: null, match: { from: 'INVOICE@acme' }, action: { labelId: tag.id, markRead: true } });

    const hit = await arrive({ from: 'Acme <invoice@acme.example>' });
    const miss = await arrive({ from: 'Pat <pat@friend.example>' });
    expect((await state(hit))!.unread_count).toBe(1);
    await applyRules(offline, hit);
    await applyRules(offline, miss);
    expect(await state(hit)).toMatchObject({ unread_count: 0, unread_messages: 0, folder: 'inbox' });
    expect(await labelsOf(hit)).toEqual([tag.id]);
    expect(await state(miss)).toMatchObject({ unread_count: 1, unread_messages: 1 });
    expect(await labelsOf(miss)).toEqual([]);
  });

  it('needs every part of a rule to match', async () => {
    await make({ name: 'Both', match: { from: 'shipping@store', subject: 'order' }, action: { star: true } });
    const both = await arrive({ from: 'shipping@store.example', subject: 'Your Order is on its way' });
    const onlyFrom = await arrive({ from: 'shipping@store.example', subject: 'Hello' });
    const onlySubject = await arrive({ from: 'x@elsewhere.example', subject: 'Order 55' });
    for (const id of [both, onlyFrom, onlySubject]) await applyRules(offline, id);
    expect((await state(both))!.starred).toBe(1);
    expect((await state(onlyFrom))!.starred).toBe(0);
    expect((await state(onlySubject))!.starred).toBe(0);
  });

  it('matches the receiving address, the body and attachments', async () => {
    await make({ name: 'Files', match: { to: 'desk@rules-test', body: 'quarterly', hasAttachment: true }, action: { star: true } });
    const yes = await arrive({ body: 'The Quarterly numbers', attachment: true });
    const noFile = await arrive({ body: 'The Quarterly numbers' });
    const noText = await arrive({ body: 'Nothing', attachment: true });
    for (const id of [yes, noFile, noText]) await applyRules(offline, id);
    expect([(await state(yes))!.starred, (await state(noFile))!.starred, (await state(noText))!.starred]).toEqual([1, 0, 0]);
  });

  it('applies every matching rule, not only the first', async () => {
    const a = await label('Alpha');
    const b = await label('Beta');
    await make({ name: 'One', match: { subject: 'multi' }, action: { labelId: a.id } });
    await make({ name: 'Two', match: { subject: 'multi' }, action: { labelId: b.id, star: true } });
    const id = await arrive({ subject: 'A multi rule message' });
    await applyRules(offline, id);
    expect((await labelsOf(id)).sort()).toEqual([a.id, b.id].sort());
    expect((await state(id))!.starred).toBe(1);
  });

  it('does nothing for a disabled rule, and again once it is switched on', async () => {
    const made = (await make({ name: 'Sleepy', match: { subject: 'sleepy' }, action: { star: true } })).body;
    const off = await call<RuleInfo>(`/api/rules/${made.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
    expect(off.body.enabled).toBe(false);
    const first = await arrive({ subject: 'sleepy one' });
    await applyRules(offline, first);
    expect((await state(first))!.starred).toBe(0);
    await call(`/api/rules/${made.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
    const second = await arrive({ subject: 'sleepy two' });
    await applyRules(offline, second);
    expect((await state(second))!.starred).toBe(1);
  });

  it('archives out of the inbox, but never pulls a trashed conversation back', async () => {
    await make({ name: 'Shelve', match: { subject: 'shelve me' }, action: { moveTo: 'archive' } });
    const id = await arrive({ subject: 'Please shelve me' });
    const mailbox = await mailboxOf(DESK);
    expect((await call<{ data: ThreadSummary[] }>(`/api/threads?view=inbox&mailbox=${mailbox}`)).body.data.some((t) => t.id === id)).toBe(true);
    await applyRules(offline, id);
    expect((await state(id))!.folder).toBe('archive');
    expect((await call<{ data: ThreadSummary[] }>(`/api/threads?view=inbox&mailbox=${mailbox}`)).body.data.some((t) => t.id === id)).toBe(false);

    const trashed = await arrive({ subject: 'Also shelve me' });
    await env.DB.prepare("UPDATE thread SET folder = 'trash' WHERE id = ?").bind(trashed).run();
    await applyRules(offline, trashed);
    expect((await state(trashed))!.folder).toBe('trash');
  });

  it('skips a label that has been deleted', async () => {
    const tag = await label('Gone');
    await make({ name: 'Orphan', match: { subject: 'orphan' }, action: { labelId: tag.id, star: true } });
    await env.DB.prepare('DELETE FROM label WHERE id = ?').bind(tag.id).run();
    const id = await arrive({ subject: 'An orphan message' });
    await applyRules(offline, id);
    expect(await labelsOf(id)).toEqual([]);
    expect((await state(id))!.starred).toBe(1);
  });

  it('keeps a rule for another mailbox from firing', async () => {
    await arrive({ to: OTHER });
    const other = await mailboxOf(OTHER);
    await make({ name: 'Shop only', mailboxId: other, match: { subject: 'scoped' }, action: { star: true } });
    const here = await arrive({ subject: 'scoped in desk' });
    const there = await arrive({ subject: 'scoped in shop', to: OTHER });
    await applyRules(offline, here);
    await applyRules(offline, there);
    expect((await state(here))!.starred).toBe(0);
    expect((await state(there))!.starred).toBe(1);
  });

  it('skips a rule with damaged stored JSON without throwing, and still runs the others', async () => {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO rule (id, name, position, enabled, match_json, action_json, created_at) VALUES ('bad-1', 'Broken', 1, 1, '{not json', '{}', ?)").bind(now),
      env.DB.prepare("INSERT INTO rule (id, name, position, enabled, match_json, action_json, created_at) VALUES ('bad-2', 'Odd', 2, 1, '[1]', 'null', ?)").bind(now),
      env.DB.prepare("INSERT INTO rule (id, name, position, enabled, match_json, action_json, created_at) VALUES ('bad-3', 'Empty', 3, 1, '{}', '{\"star\":true}', ?)").bind(now),
    ]);
    await make({ name: 'Fine', match: { subject: 'damaged' }, action: { star: true } });
    const id = await arrive({ subject: 'Damaged neighbours' });
    await expect(applyRules(offline, id)).resolves.toBeUndefined();
    expect((await state(id))!.starred).toBe(1);
    const plain = await arrive({ subject: 'Plain' });
    await applyRules(offline, plain);
    expect((await state(plain))!.starred).toBe(0); // an empty match never matches
  });
});

describe('rule routes', () => {
  it('validates what is sent', async () => {
    const tag = await label('Check');
    const ok = { name: 'Ok', match: { subject: 'x' }, action: { star: true } };
    expect((await make({ ...ok, match: {} })).body.error).toBe('no_condition');
    expect((await make({ ...ok, match: { from: '   ' } })).body.error).toBe('no_condition');
    expect((await make({ ...ok, action: {} })).body.error).toBe('no_action');
    expect((await make({ ...ok, action: { labelId: 'no-such-label' } })).body.error).toBe('unknown_label');
    expect((await make({ ...ok, action: { moveTo: 'inbox' } })).body.error).toBe('bad_move');
    expect((await make({ ...ok, mailboxId: 'no-such-mailbox' })).body.error).toBe('unknown_mailbox');
    expect((await make({ ...ok, name: '  ' })).body.error).toBe('no_name');
    expect((await make({ ...ok, name: 'x'.repeat(61) })).body.error).toBe('name_too_long');
    expect((await make({ ...ok, match: { subject: 'x'.repeat(201) } })).body.error).toBe('condition_too_long');
    const trimmed = await make({ ...ok, match: { subject: '  padded  ' }, action: { labelId: tag.id } });
    expect(trimmed.body.match).toEqual({ subject: 'padded' });
  });

  it('lists, updates in place, and deletes with an unknown id answering 404', async () => {
    const made = (await make({ name: 'First', match: { subject: 'one' }, action: { star: true } })).body;
    const updated = await make({ id: made.id, name: 'Renamed', match: { subject: 'two' }, action: { markRead: true } });
    expect(updated.body).toMatchObject({ id: made.id, name: 'Renamed', match: { subject: 'two' }, action: { markRead: true } });
    const listed = (await call<{ data: RuleInfo[] }>('/api/rules')).body.data;
    expect(listed.map((r) => r.id)).toEqual([made.id]);
    expect((await call<unknown>(`/api/rules/${made.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await call<{ data: RuleInfo[] }>('/api/rules')).body.data).toHaveLength(0);
    const missing = await call<{ error: string }>('/api/rules/nope', { method: 'DELETE' });
    expect([missing.status, missing.body.error]).toEqual([404, 'not_found']);
    expect((await call<{ error: string }>('/api/rules/nope/run', post({}))).body.error).toBe('not_found');
    expect((await make({ id: 'nope', name: 'x', match: { subject: 'x' }, action: { star: true } })).status).toBe(404);
  });

  it('refuses members with 403', async () => {
    const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
    const jwk = { ...(await exportJWK(publicKey)), kid: 'host-rules', alg: 'EdDSA' };
    const hosted = { ...env, AUTH_MODE: 'access', HOST_PUBLIC_KEYS: JSON.stringify([jwk]) } as Env;
    const token = await new SignJWT({ role: 'member', name: 'rules-member' }).setProtectedHeader({ alg: 'EdDSA', kid: 'host-rules' })
      .setIssuer('host-app').setAudience('sadi-mail').setSubject('rules-member').setIssuedAt().setExpirationTime('5m').sign(privateKey);
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const made = (await make({ name: 'Mine', match: { subject: 'x' }, action: { star: true } })).body;
    const attempts: [string, string, unknown?][] = [['GET', '/api/rules'], ['POST', '/api/rules', { name: 'x', match: { subject: 'x' }, action: { star: true } }], ['PATCH', `/api/rules/${made.id}`, { enabled: false }], ['DELETE', `/api/rules/${made.id}`], ['POST', `/api/rules/${made.id}/run`, {}]];
    for (const [method, path, body] of attempts) {
      const res = await call<{ error: string }>(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), env: hosted });
      expect([method, path.replace(made.id, ':id'), res.status, res.body.error]).toEqual([method, path.replace(made.id, ':id'), 403, 'forbidden']);
    }
    expect((await call<{ data: RuleInfo[] }>('/api/rules')).body.data).toHaveLength(1);
  });

  it('runs one rule over existing inbox mail and counts matches', async () => {
    const old1 = await arrive({ subject: 'Backlog newsletter A' });
    const old2 = await arrive({ subject: 'Backlog newsletter B' });
    const other = await arrive({ subject: 'Unrelated backlog' });
    const tag = await label('Backlog');
    const made = (await make({ name: 'Backlog', match: { subject: 'backlog newsletter' }, action: { labelId: tag.id, moveTo: 'archive' } })).body;
    const run = await call<{ matched: number }>(`/api/rules/${made.id}/run`, post({}));
    expect(run).toMatchObject({ status: 200, body: { matched: 2 } });
    expect((await state(old1))!.folder).toBe('archive');
    expect(await labelsOf(old2)).toEqual([tag.id]);
    expect((await state(other))!.folder).toBe('inbox');
    // They have left the inbox, so a second run finds nothing more.
    expect((await call<{ matched: number }>(`/api/rules/${made.id}/run`, post({}))).body.matched).toBe(0);
  });
});
