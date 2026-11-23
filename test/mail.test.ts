import { env } from 'cloudflare:test';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import type { Bootstrap, SendResult, ThreadDetail, ThreadSummary } from '../src/shared/types';
import { sweepUnindexed } from '../src/worker/ingest';
import { cleanHtml } from '../src/worker/sanitize';
import { baseSubject, ftsQuery, parseAuthResults, type Env } from '../src/worker/util';
import { call, deliver, post } from './helpers';

type List = { data: ThreadSummary[]; nextCursor: string | null };

describe('receiving', () => {
  it('stores the raw message in R2 and indexes it', async () => {
    const result = await deliver({ from: 'Vincent Moreau <vincent@print.example>', to: 'hello@fieldwork.example', subject: 'Invoice INV-2291', body: 'Please find the invoice for the brochures.' });
    expect(result.outcome).toBe('stored');
    if (result.outcome !== 'stored') return;
    expect(result.indexed).toBe(true);

    const raw = await env.MAIL.get(result.rawKey);
    expect(await raw!.text()).toContain('Subject: Invoice INV-2291');

    const list = await call<List>('/api/threads?view=inbox');
    const thread = list.body.data.find((t) => t.id === result.threadId)!;
    expect(thread.subject).toBe('Invoice INV-2291');
    expect(thread.fromName).toBe('Vincent Moreau');
    expect(thread.unread).toBe(true);
    expect(thread.addressEmail).toBe('hello@fieldwork.example');
  });

  it('keeps a reply in the same conversation', async () => {
    const first = await deliver({ from: 'lena@kontur.example', to: 'hello@fieldwork.example', subject: 'Homepage copy', body: 'Round one.', messageId: 'copy-1@kontur.example' });
    const second = await deliver({ from: 'lena@kontur.example', to: 'hello@fieldwork.example', subject: 'Re: Homepage copy', body: 'Round two.', inReplyTo: 'copy-1@kontur.example' });
    expect(first.outcome === 'stored' && second.outcome === 'stored' && first.threadId === second.threadId).toBe(true);
    if (first.outcome !== 'stored') return;
    const detail = await call<ThreadDetail>(`/api/threads/${first.threadId}`);
    expect(detail.body.messages.map((m) => m.text.trim())).toEqual(['Round one.', 'Round two.']);
    expect(detail.body.messageCount).toBe(2);
  });

  it('delivers plus-addresses to the base address and discovers new aliases', async () => {
    await deliver({ from: 'a@x.example', to: 'hello+news@fieldwork.example', subject: 'Tagged', body: 'x' });
    await deliver({ from: 'a@x.example', to: 'billing@fieldwork.example', subject: 'New alias', body: 'x' });
    const boot = await call<Bootstrap>('/api/bootstrap');
    const emails = boot.body.mailboxes.flatMap((m) => m.addresses.map((a) => a.email));
    expect(emails).toContain('billing@fieldwork.example');
    expect(emails).not.toContain('hello+news@fieldwork.example');
    expect(boot.body.mailboxes.filter((m) => m.addresses.some((a) => a.email.endsWith('@fieldwork.example')))).toHaveLength(1);
  });

  it('refuses unknown recipients when told to', async () => {
    const strict: Env = { ...env, UNKNOWN_RECIPIENT: 'reject' };
    const result = await deliver({ from: 'a@x.example', to: 'nobody@unknown-domain.example', subject: 'Hi', body: 'x' }, strict);
    expect(result.outcome).toBe('rejected');
  });

  it('never reports success when R2 cannot take the message', async () => {
    const before = (await env.DB.prepare('SELECT COUNT(*) AS n FROM message').first<{ n: number }>())!.n;
    const broken = { ...env, MAIL: { ...env.MAIL, put: () => Promise.reject(new Error('R2 unavailable')) } } as unknown as Env;
    await expect(deliver({ from: 'a@x.example', to: 'hello@fieldwork.example', subject: 'Lost?', body: 'x' }, broken)).rejects.toThrow('R2 unavailable');
    const after = (await env.DB.prepare('SELECT COUNT(*) AS n FROM message').first<{ n: number }>())!.n;
    expect(after).toBe(before);
  });

  it('keeps the message when indexing fails, and the sweep repairs it', async () => {
    const noBatch = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'batch') return () => Promise.reject(new Error('D1 unavailable'));
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const result = await deliver({ from: 'a@x.example', to: 'hello@fieldwork.example', subject: 'Survives an outage', body: 'still here' }, { ...env, DB: noBatch });
    expect(result).toMatchObject({ outcome: 'stored', indexed: false });
    if (result.outcome !== 'stored') return;
    expect(await env.MAIL.head(result.rawKey)).not.toBeNull();

    const repaired = await sweepUnindexed(env, Date.now() + 120_000);
    expect(repaired).toBe(1);
    const found = await call<List>('/api/search?q=survives');
    expect(found.body.data.map((t) => t.subject)).toContain('Survives an outage');
    expect(await sweepUnindexed(env, Date.now() + 120_000)).toBe(0);
  });

  it('stores attachments and serves them as downloads only', async () => {
    const result = await deliver({ from: 'a@x.example', to: 'hello@fieldwork.example', subject: 'With file', body: 'see attached', attachment: { filename: 'INV-1.pdf', content: '%PDF-fake' } });
    if (result.outcome !== 'stored') throw new Error('not stored');
    const detail = await call<ThreadDetail>(`/api/threads/${result.threadId}`);
    const file = detail.body.messages[0]!.attachments[0]!;
    expect(file).toMatchObject({ filename: 'INV-1.pdf', size: 9 });
    expect(detail.body.hasAttachment).toBe(true);
  });

  it('flags a message that failed DMARC', async () => {
    const result = await deliver({ from: 'hr@lookalike.example', to: 'hello@fieldwork.example', subject: 'Verify payroll', body: 'click', auth: 'spf=fail; dkim=none; dmarc=fail' });
    if (result.outcome !== 'stored') throw new Error('not stored');
    const detail = await call<ThreadDetail>(`/api/threads/${result.threadId}`);
    expect(detail.body.flaggedAuth).toBe(true);
    expect(detail.body.messages[0]!.auth.dmarc).toBe('fail');
  });
});

describe('reading and organising', () => {
  it('searches across every mailbox and narrows to one', async () => {
    await deliver({ from: 'aisha@halcyon.example', to: 'studio@northwind.example', subject: 'Contract draft', body: 'Clause seven on intellectual property transfer.' });
    const all = await call<List>('/api/search?q=intellectual');
    expect(all.body.data).toHaveLength(1);
    const boot = await call<Bootstrap>('/api/bootstrap');
    const other = boot.body.mailboxes.find((m) => m.addresses.some((a) => a.email === 'hello@fieldwork.example'))!;
    const narrowed = await call<List>(`/api/search?q=intellectual&mailbox=${other.id}`);
    expect(narrowed.body.data).toHaveLength(0);
  });

  it('marks read, stars, archives, and a new reply brings the conversation back', async () => {
    const result = await deliver({ from: 'tomas@ortega.example', to: 'hello@fieldwork.example', subject: 'Coffee', body: 'Tuesday?', messageId: 'coffee-1@ortega.example' });
    if (result.outcome !== 'stored') throw new Error('not stored');
    const id = result.threadId!;
    expect((await call<ThreadSummary>(`/api/threads/${id}/actions`, post({ action: 'read' }))).body.unread).toBe(false);
    expect((await call<ThreadSummary>(`/api/threads/${id}/actions`, post({ action: 'star' }))).body.starred).toBe(true);
    expect((await call<ThreadSummary>(`/api/threads/${id}/actions`, post({ action: 'archive' }))).body.folder).toBe('archive');
    expect((await call<List>('/api/threads?view=inbox')).body.data.some((t) => t.id === id)).toBe(false);
    await deliver({ from: 'tomas@ortega.example', to: 'hello@fieldwork.example', subject: 'Re: Coffee', body: 'Or Wednesday?', inReplyTo: 'coffee-1@ortega.example' });
    const back = (await call<List>('/api/threads?view=inbox')).body.data.find((t) => t.id === id)!;
    expect(back.unread).toBe(true);
  });

  it('pages through a long list without repeating or skipping', async () => {
    const first = await call<List>('/api/threads?view=inbox&limit=3');
    expect(first.body.data).toHaveLength(3);
    expect(first.body.nextCursor).not.toBeNull();
    const second = await call<List>(`/api/threads?view=inbox&limit=3&cursor=${first.body.nextCursor}`);
    const ids = new Set([...first.body.data, ...second.body.data].map((t) => t.id));
    expect(ids.size).toBe(first.body.data.length + second.body.data.length);
  });
});

describe('sending', () => {
  it('replies from the address the mail was sent to, and sends nothing in dry-run', async () => {
    const result = await deliver({ from: 'Priya <priya@nair.example>', to: 'billing@fieldwork.example', subject: 'Photos', body: 'Selects attached.', messageId: 'photos-1@nair.example' });
    if (result.outcome !== 'stored') throw new Error('not stored');
    const detail = (await call<ThreadDetail>(`/api/threads/${result.threadId}`)).body;
    const boot = (await call<Bootstrap>('/api/bootstrap')).body;
    const replyFrom = boot.mailboxes.flatMap((m) => m.addresses).find((a) => a.id === detail.replyFrom)!;
    expect(replyFrom.email).toBe('billing@fieldwork.example');
    expect(boot.sendMode).toBe('dry-run');

    let sends = 0;
    const watched: Env = { ...env, EMAIL: { send: async () => { sends++; return { messageId: 'x' }; } } };
    const sent = await call<SendResult>('/api/send', { ...post({ fromAddressId: detail.replyFrom, to: [{ name: 'Priya', email: 'priya@nair.example' }], subject: 'Re: Photos', text: 'These are great.', inReplyToMessageId: detail.messages[0]!.id }), env: watched });
    expect(sent.body).toMatchObject({ status: 'dry_run', dryRun: true, threadId: detail.id });
    expect(sends).toBe(0);

    const after = (await call<ThreadDetail>(`/api/threads/${detail.id}`)).body;
    expect(after.messages).toHaveLength(2);
    expect(after.messages[1]).toMatchObject({ direction: 'out', status: 'dry_run', from: { email: 'billing@fieldwork.example' } });
    expect((await call<List>('/api/threads?view=sent')).body.data.some((t) => t.id === detail.id)).toBe(true);
  });

  it('refuses a message with no valid recipient', async () => {
    const boot = (await call<Bootstrap>('/api/bootstrap')).body;
    const from = boot.mailboxes[0]!.addresses[0]!.id;
    const bad = await call<{ error: string }>('/api/send', post({ fromAddressId: from, to: [{ name: '', email: 'not-an-address' }], subject: 'x', text: 'x' }));
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe('invalid_recipient');
  });

  it('holds a scheduled message until its time', async () => {
    const boot = (await call<Bootstrap>('/api/bootstrap')).body;
    const from = boot.mailboxes[0]!.addresses[0]!.id;
    const sent = await call<SendResult>('/api/send', post({ fromAddressId: from, to: [{ name: '', email: 'later@x.example' }], subject: 'Later', text: 'Tomorrow.', scheduledFor: Date.now() + 86_400_000 }));
    expect(sent.body.status).toBe('scheduled');
    expect((await call<List>('/api/threads?view=scheduled')).body.data.some((t) => t.id === sent.body.threadId)).toBe(true);
  });
});

describe('permissions', () => {
  async function hostEnv() {
    const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
    const jwk = { ...(await exportJWK(publicKey)), kid: 'host-1', alg: 'EdDSA' };
    const token = (role: string, sub: string) =>
      new SignJWT({ role, name: sub }).setProtectedHeader({ alg: 'EdDSA', kid: 'host-1' }).setIssuer('host-app').setAudience('sadi-mail').setSubject(sub).setIssuedAt().setExpirationTime('5m').sign(privateKey);
    return { hosted: { ...env, AUTH_MODE: 'access', HOST_PUBLIC_KEYS: JSON.stringify([jwk]) } as Env, token };
  }

  it('lets a host application sign a person in, who sees nothing until granted a mailbox', async () => {
    const { hosted, token } = await hostEnv();
    const headers = { authorization: `Bearer ${await token('member', 'sam')}` };
    const boot = await call<Bootstrap>('/api/bootstrap', { headers, env: hosted });
    expect(boot.status).toBe(200);
    expect(boot.body.user.role).toBe('member');
    expect(boot.body.mailboxes).toHaveLength(0);
    expect((await call<List>('/api/threads?view=inbox', { headers, env: hosted })).body.data).toHaveLength(0);
    expect((await call<List>('/api/search?q=invoice', { headers, env: hosted })).body.data).toHaveLength(0);

    // A conversation in a mailbox they cannot read looks exactly like one that does not exist.
    const any = (await call<List>('/api/threads?view=inbox')).body.data[0]!;
    expect((await call<unknown>(`/api/threads/${any.id}`, { headers, env: hosted })).status).toBe(404);
    expect((await call<unknown>('/api/threads/does-not-exist', { headers, env: hosted })).status).toBe(404);
    expect((await call<unknown>('/api/users', { headers, env: hosted })).status).toBe(403);
  });

  it('applies read-only and send grants', async () => {
    const { hosted, token } = await hostEnv();
    const headers = { authorization: `Bearer ${await token('member', 'riya')}`, 'content-type': 'application/json' };
    await call<Bootstrap>('/api/bootstrap', { headers, env: hosted });
    const users = (await call<{ data: { id: string; name: string }[] }>('/api/users')).body.data;
    const riya = users.find((u) => u.name === 'riya')!;
    const mailbox = (await call<Bootstrap>('/api/bootstrap')).body.mailboxes[0]!;

    await call('/api/users/' + riya.id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grants: [{ mailboxId: mailbox.id, read: true, send: false, edit: false, delete: false }] }) });
    const boot = (await call<Bootstrap>('/api/bootstrap', { headers, env: hosted })).body;
    expect(boot.mailboxes.map((m) => m.id)).toEqual([mailbox.id]);
    expect(boot.mailboxes[0]!.can).toEqual({ send: false, edit: false, delete: false });

    const thread = (await call<List>(`/api/threads?view=inbox&mailbox=${mailbox.id}`, { headers, env: hosted })).body.data[0]!;
    expect((await call<unknown>(`/api/threads/${thread.id}/actions`, { method: 'POST', headers, body: JSON.stringify({ action: 'trash' }), env: hosted })).status).toBe(403);
    const send = await call<unknown>('/api/send', { method: 'POST', headers, body: JSON.stringify({ fromAddressId: mailbox.addresses[0]!.id, to: [{ name: '', email: 'x@y.example' }], subject: 's', text: 't' }), env: hosted });
    expect(send.status).toBe(403);
  });

  it('rejects an unsigned or wrongly signed token, and refuses dev sign-in off localhost', async () => {
    const { hosted } = await hostEnv();
    const other = await hostEnv();
    const forged = await other.token('admin', 'mallory');
    expect((await call<unknown>('/api/bootstrap', { headers: { authorization: `Bearer ${forged}` }, env: hosted })).status).toBe(401);
    expect((await call<unknown>('/api/bootstrap', { env: hosted })).status).toBe(401);
    const { api } = await import('../src/worker/api');
    const remote = await api.fetch(new Request('https://mail.example.com/api/bootstrap'), env, {} as ExecutionContext);
    expect(remote.status).toBe(401);
  });

  it('follows the role the host application gives, on every sign-in', async () => {
    const { hosted, token } = await hostEnv();
    const as = async (role: string) => (await call<Bootstrap>('/api/bootstrap', { headers: { authorization: `Bearer ${await token(role, 'dana')}` }, env: hosted })).body.user.role;
    expect(await as('member')).toBe('member');
    expect(await as('admin')).toBe('admin');
    expect(await as('viewer')).toBe('viewer');
    expect(await as('owner')).toBe('member'); // a host token can never make an owner
  });

  it('never leaves an installation without an owner', async () => {
    const users = (await call<{ data: { id: string; role: string }[] }>('/api/users')).body.data;
    const owner = users.find((u) => u.role === 'owner')!;
    const res = await call<{ error: string }>('/api/users/' + owner.id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'member' }) });
    expect(res.status).toBe(409);
  });
});

describe('message HTML', () => {
  it('removes anything that can run code or call home', async () => {
    const dirty = `<div onclick="steal()"><script>alert(1)</script><img src="https://track.example/p.gif" onerror="x()"><a href="javascript:alert(1)">bad</a><a href="https://ok.example/">good</a><iframe src="https://evil.example"></iframe><form action="https://evil.example"><input name="p"></form><p style="background:url(https://track.example/bg.png)">Hello</p></div>`;
    const blocked = await cleanHtml(dirty, { loadImages: false });
    expect(blocked.hasRemoteImages).toBe(true);
    for (const bad of ['<script', 'onclick', 'onerror', 'javascript:', '<iframe', '<form', '<input', 'track.example']) expect(blocked.html).not.toContain(bad);
    expect(blocked.html).toContain('href="https://ok.example/"');
    expect(blocked.html).toContain('rel="noopener noreferrer nofollow"');
    expect(blocked.html).toContain('Hello');

    const loaded = await cleanHtml(dirty, { loadImages: true });
    expect(loaded.html).toContain('src="https://track.example/p.gif"');
    expect(loaded.html).not.toContain('onerror');
  });

  it('serves stored HTML cleaned', async () => {
    const result = await deliver({ from: 'news@margin.example', to: 'hello@fieldwork.example', subject: 'Issue 112', html: '<h1>Pricing</h1><img src="https://pixel.example/o.gif"><script>1</script>' });
    if (result.outcome !== 'stored') throw new Error('not stored');
    const message = (await call<ThreadDetail>(`/api/threads/${result.threadId}`)).body.messages[0]!;
    expect(message.hasRemoteImages).toBe(true);
    expect(message.html).not.toContain('pixel.example');
    expect(message.html).not.toContain('<script');
    expect(message.text).toContain('Pricing');
  });

  it('does not treat automated mail as waiting for a reply', async () => {
    const a = await deliver({ from: 'no-reply@shop.example', to: 'hello@fieldwork.example', subject: 'Your receipt', body: 'Thanks.' });
    const b = await deliver({ from: 'sam@client.example', to: 'hello@fieldwork.example', subject: 'Quick question', body: 'Can you call me?' });
    const list = (await call<List>('/api/threads?view=inbox')).body.data;
    expect(list.find((t) => a.outcome === 'stored' && t.id === a.threadId)!.needsReply).toBe(false);
    expect(list.find((t) => b.outcome === 'stored' && t.id === b.threadId)!.needsReply).toBe(true);
  });
});

describe('helpers', () => {
  it('normalises subjects, reads authentication results and builds search queries', () => {
    expect(baseSubject('Re: RE: Fwd: Hello')).toBe('Hello');
    expect(parseAuthResults('mx.cloudflare.net; spf=pass smtp.mailfrom=a; dkim=pass; dmarc=fail')).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'fail' });
    expect(parseAuthResults(null)).toEqual({ spf: 'none', dkim: 'none', dmarc: 'none' });
    expect(ftsQuery('invoice vinc')).toBe('"invoice" "vinc"*');
    expect(ftsQuery('  "  ')).toBeNull();
  });
});

describe('without any AI', () => {
  it('receives, files, searches and sends with AI agents switched on but no provider connected', async () => {
    const { runOnReceive } = await import('../src/worker/assistant');
    const { offline } = await import('./helpers');
    const agents = (await call<{ agents: { id: string; usesAi: boolean }[] }>('/api/ai')).body.agents;
    for (const a of agents.filter((x) => x.usesAi)) await call(`/api/ai/agents/${a.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) });

    const r = await deliver({ from: 'Mina <mina@client.example>', to: 'hello@fieldwork.example', subject: 'No AI needed', body: 'Plain mail still works.' });
    if (r.outcome !== 'stored') throw new Error('not stored');
    await expect(runOnReceive(offline, r.threadId!)).resolves.toBeUndefined(); // agents fail quietly; mail is unaffected
    const boot = (await call<Bootstrap>('/api/bootstrap')).body;
    expect(boot.ai.connected).toBe(false);
    const thread = (await call<List>('/api/threads?view=inbox&section=primary&limit=100')).body.data.find((t) => t.id === r.threadId)!;
    expect(thread).toMatchObject({ subject: 'No AI needed', unread: true, section: 'primary', needsReply: true });
    expect((await call<List>('/api/search?q=plain+mail')).body.data.some((t) => t.id === r.threadId)).toBe(true);
    const detail = (await call<ThreadDetail>(`/api/threads/${r.threadId}`)).body;
    const sent = await call<SendResult>('/api/send', post({ fromAddressId: detail.replyFrom, to: [detail.messages[0]!.from], subject: 'Re: No AI needed', text: 'Agreed.', inReplyToMessageId: detail.messages[0]!.id }));
    expect(sent.body.status).toBe('dry_run');
    for (const a of agents.filter((x) => x.usesAi)) await call(`/api/ai/agents/${a.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
  });
});
