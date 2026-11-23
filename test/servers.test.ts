import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import type { Bootstrap, MailServerInfo, SendResult, ThreadSummary } from '../src/shared/types';
import { setDial } from '../src/worker/servers';
import { buildMime } from '../src/worker/smtp';
import type { Env } from '../src/worker/util';
import { Conn, b64text } from '../src/worker/wire';
import { call, deliver, eml, post } from './helpers';

const withKey = { ...env, AI: undefined, MAIL_SECRET_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(9))) } as unknown as Env;
const api = <T>(path: string, init: RequestInit = {}) => call<T>(path, { ...init, env: withKey });
const PASS = 'app-pass "quoted"';

/** A scripted mail server in memory: SMTP on port 2525, IMAP on port 2143. */
function fakeServer() {
  const sent: { from: string; to: string[]; data: string }[] = [];
  const inbox: { uid: number; raw: string }[] = [];
  let nextUid = 41;
  const add = (raw: string) => inbox.push({ uid: nextUid++, raw });

  async function smtp(c: Conn) {
    await c.write('220 fake ESMTP\r\n');
    let mail = { from: '', to: [] as string[], data: '' };
    for (;;) {
      const l = await c.line();
      if (/^EHLO/i.test(l)) await c.write('250-fake\r\n250-SIZE 1000000\r\n250 AUTH PLAIN LOGIN\r\n');
      else if (/^AUTH PLAIN /i.test(l)) await c.write(l.slice(11) === b64text(`\0x@srv-test.example\0${PASS}`) ? '235 ok\r\n' : '535 5.7.8 Wrong user name or password\r\n');
      else if (/^MAIL FROM/i.test(l)) { mail = { from: l, to: [], data: '' }; await c.write('250 ok\r\n'); }
      else if (/^RCPT TO/i.test(l)) { mail.to.push(l); await c.write('250 ok\r\n'); }
      else if (/^DATA/i.test(l)) {
        await c.write('354 go\r\n');
        const lines: string[] = [];
        for (let d = await c.line(); d !== '.'; d = await c.line()) lines.push(d.startsWith('..') ? d.slice(1) : d);
        mail.data = lines.join('\r\n');
        sent.push(mail);
        await c.write('250 queued as 1\r\n');
      } else if (/^QUIT/i.test(l)) { await c.write('221 bye\r\n'); return; }
      else await c.write('500 what\r\n');
    }
  }

  async function imap(c: Conn) {
    await c.write('* OK fake IMAP ready\r\n');
    for (;;) {
      const l = await c.line();
      const tag = l.split(' ')[0]!;
      const rest = l.slice(tag.length + 1);
      if (/^LOGIN/i.test(rest)) await c.write(rest === `LOGIN "x@srv-test.example" "app-pass \\"quoted\\""` ? `${tag} OK in\r\n` : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
      else if (/^EXAMINE INBOX/i.test(rest)) await c.write(`* ${inbox.length} EXISTS\r\n* OK [UIDVALIDITY 7] ok\r\n* OK [UIDNEXT ${nextUid}] ok\r\n${tag} OK [READ-ONLY] done\r\n`);
      else if (/^UID SEARCH UID (\d+):\*/i.test(rest)) {
        const from = Number(/UID (\d+):/i.exec(rest)![1]);
        // Like real servers, "n:*" always includes the newest message, even when it is older than n.
        const hits = new Set(inbox.filter((m) => m.uid >= from).map((m) => m.uid));
        if (inbox.length) hits.add(inbox[inbox.length - 1]!.uid);
        await c.write(`* SEARCH ${[...hits].join(' ')}\r\n${tag} OK done\r\n`);
      } else if (/^UID FETCH [\d,]+ \(UID RFC822\.SIZE\)/i.test(rest)) {
        for (const uid of rest.split(' ')[2]!.split(',').map(Number)) await c.write(`* 1 FETCH (UID ${uid} RFC822.SIZE ${inbox.find((m) => m.uid === uid)!.raw.length})\r\n`);
        await c.write(`${tag} OK done\r\n`);
      } else if (/^UID FETCH \d+ \(UID BODY\.PEEK\[\]\)/i.test(rest)) {
        const m = inbox.find((x) => x.uid === Number(rest.split(' ')[2]))!;
        const bytes = new TextEncoder().encode(m.raw);
        await c.write(`* 1 FETCH (UID ${m.uid} BODY[] {${bytes.length}}\r\n`);
        await c.write(bytes);
        await c.write(`)\r\n${tag} OK done\r\n`);
      } else if (/^LOGOUT/i.test(rest)) { await c.write(`* BYE\r\n${tag} OK bye\r\n`); return; }
      else await c.write(`${tag} BAD what\r\n`);
    }
  }

  setDial((_host, port) => {
    const up = new TransformStream<Uint8Array, Uint8Array>();
    const down = new TransformStream<Uint8Array, Uint8Array>();
    const server = new Conn({ readable: up.readable, writable: down.writable, close: async () => {} });
    void (port === 2525 ? smtp(server) : imap(server)).catch(() => undefined);
    return { readable: down.readable, writable: up.writable, close: async () => {} };
  });
  return { sent, add };
}

afterEach(() => setDial(null));

const account = { email: 'x@srv-test.example', password: PASS, smtpHost: 'localhost', smtpPort: 2525, smtpSecurity: 'none', imapHost: 'localhost', imapPort: 2143, imapSecurity: 'none' };

describe('mail servers outside Cloudflare', () => {
  it('refuses port 25, and an unencrypted connection to a real host', async () => {
    expect((await api<{ error: string }>('/api/mail-servers', post({ ...account, smtpPort: 25 }))).body.error).toBe('port_25');
    expect((await api<{ error: string }>('/api/mail-servers', post({ ...account, smtpHost: 'smtp.example.com' }))).body.error).toBe('needs_tls');
    expect((await api<{ error: string }>('/api/mail-servers', post({ ...account, smtpHost: '', imapHost: '' }))).body.error).toBe('no_server');
  });

  it('signs in, sends through SMTP and brings new mail in over IMAP without duplicates', async () => {
    const fake = fakeServer();
    await deliver({ from: 'a@b.example', to: 'x@srv-test.example', subject: 'Makes the address', body: 'hi' });
    fake.add(eml({ from: 'Old <old@far.example>', to: 'x@srv-test.example', subject: 'Already there before connecting', body: 'old' }));

    const made = await api<MailServerInfo & { password?: string }>('/api/mail-servers', post(account));
    expect(made.status).toBe(200);
    expect(made.body.password).toBeUndefined();
    expect(JSON.stringify(made.body)).not.toContain('app-pass');
    const id = made.body.id;

    const tested = await api<{ smtp: { ok: boolean }; imap: { ok: boolean; detail: string } }>(`/api/mail-servers/${id}/test`, post({}));
    expect(tested.body.smtp.ok).toBe(true);
    expect(tested.body.imap.ok).toBe(true);
    expect(tested.body.imap.detail).toContain('1 message');

    // Sending: off until switched on, then real even though the installation is in dry run.
    await api(`/api/mail-servers/${id}`, { ...post({ sendEnabled: true, receiveEnabled: true }), method: 'PATCH' });
    const boot = (await api<Bootstrap>('/api/bootstrap')).body;
    expect(boot.serverSenders).toEqual(['x@srv-test.example']);
    const from = boot.mailboxes.flatMap((m) => m.addresses).find((a) => a.email === 'x@srv-test.example')!;
    const result = await api<SendResult>('/api/send', post({ fromAddressId: from.id, to: [{ name: 'রিমা', email: 'rima@far.example' }], subject: 'অর্ডার নিশ্চিত', text: 'Line one\n.starts with a dot' }));
    expect(result.body.status).toBe('sent');
    expect(result.body.dryRun).toBe(false);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.to).toEqual(['RCPT TO:<rima@far.example>']);
    expect(fake.sent[0]!.data).toContain('Subject: =?UTF-8?B?');
    expect(fake.sent[0]!.data).toContain(b64text('Line one\n.starts with a dot'));

    // Receiving: the first visit only notes where the inbox ends.
    expect((await api<{ stored: number }>(`/api/mail-servers/${id}/check`, post({}))).body.stored).toBe(0);
    fake.add(eml({ from: 'New <new@far.example>', to: 'x@srv-test.example', subject: 'Arrived after connecting', body: 'fresh' }));
    expect((await api<{ stored: number }>(`/api/mail-servers/${id}/check`, post({}))).body.stored).toBe(1);
    expect((await api<{ stored: number }>(`/api/mail-servers/${id}/check`, post({}))).body.stored).toBe(0);
    const subjects = (await api<{ data: ThreadSummary[] }>('/api/threads?view=inbox')).body.data.map((t) => t.subject);
    expect(subjects).toContain('Arrived after connecting');
    expect(subjects).not.toContain('Already there before connecting');
  });

  it('reports a wrong password in plain words and never stores it readable', async () => {
    fakeServer();
    await deliver({ from: 'a@b.example', to: 'y@srv-test.example', subject: 'Makes the address', body: 'hi' });
    const made = await api<MailServerInfo>('/api/mail-servers', post({ ...account, email: 'y@srv-test.example', password: 'wrong' }));
    const tested = await api<{ smtp: { ok: boolean; detail: string }; imap: { ok: boolean; detail: string } }>(`/api/mail-servers/${made.body.id}/test`, post({}));
    expect(tested.body.smtp).toEqual({ ok: false, detail: 'Signing in: the server answered 535 5.7.8 Wrong user name or password' });
    expect(tested.body.imap.ok).toBe(false);
    const stored = await env.DB.prepare('SELECT pass_cipher FROM mail_server WHERE id = ?').bind(made.body.id).first<{ pass_cipher: string }>();
    expect(stored!.pass_cipher).not.toContain('wrong');
  });

  it('builds a message with text, HTML and an attachment', () => {
    const raw = buildMime({ from: { name: 'Shop', email: 's@x.example' }, to: [{ name: '', email: 't@y.example' }], cc: [], bcc: [{ name: '', email: 'hidden@y.example' }], subject: 'Hi', text: 'plain', html: '<p>rich</p>', inReplyTo: 'abc@y.example', references: ['abc@y.example'], attachments: [{ filename: 'a.pdf', mime: 'application/pdf', base64: 'AAAA' }] }, 'id1@x.example', 0);
    expect(raw).toContain('multipart/mixed');
    expect(raw).toContain('multipart/alternative');
    expect(raw).toContain('In-Reply-To: <abc@y.example>');
    expect(raw).toContain('filename="a.pdf"');
    expect(raw).not.toContain('hidden@y.example');
  });
});
