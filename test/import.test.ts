import { env } from 'cloudflare:test';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import type { ThreadDetail, ThreadSummary } from '../src/shared/types';
import type { Env } from '../src/worker/util';
import { call } from './helpers';

// Every test file shares one database, so everything here uses its own domain and a per-run tag.
const ADDRESS = 'old@import-test.example';
const RUN = Date.now().toString(36);

type Imported = { status: 'imported'; threadId: string; messageId: string };
type Result = Imported | { status: 'duplicate' };
type List = { data: ThreadSummary[] };

interface Mail {
  from?: string;
  to?: string;
  subject: string;
  date: string;
  messageId?: string | null;
  inReplyTo?: string;
  body: string;
}

function raw(m: Mail): string {
  return [
    `From: ${m.from ?? 'Lena Park <lena@friends.example>'}`,
    `To: ${m.to ?? `Old Me <${ADDRESS}>`}`,
    `Subject: ${m.subject}`,
    `Date: ${m.date}`,
    ...(m.messageId === null ? [] : [`Message-ID: <${m.messageId ?? `${crypto.randomUUID()}@friends.example`}>`]),
    ...(m.inReplyTo ? [`In-Reply-To: <${m.inReplyTo}>`, `References: <${m.inReplyTo}>`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    m.body,
    '',
  ].join('\r\n');
}

const upload = (body: string | Uint8Array, query: Record<string, string> = {}, init: RequestInit & { env?: Env } = {}) =>
  call<Result & { error?: string }>(`/api/import/message?${new URLSearchParams({ address: ADDRESS, ...query })}`, {
    method: 'POST',
    body,
    ...init,
    headers: { 'content-type': 'message/rfc822', ...(init.headers as Record<string, string> | undefined) },
  });

async function imported(body: string, query: Record<string, string> = {}): Promise<Imported> {
  const r = await upload(body, query);
  expect(r.status).toBe(200);
  expect(r.body.status).toBe('imported');
  return r.body as Imported;
}

const thread = async (id: string) => (await call<ThreadDetail>(`/api/threads/${id}`)).body;
const list = async (view: string, mailboxId: string) => (await call<List>(`/api/threads?view=${view}&mailbox=${mailboxId}&limit=100`)).body.data;

describe('importing mail', () => {
  it('files an old message in the inbox at its own date, read unless told otherwise', async () => {
    const at = Date.UTC(2019, 4, 1, 8, 30);
    const unread = await imported(raw({ subject: `Old unread ${RUN}`, date: new Date(at).toUTCString(), body: 'From long ago.' }), { read: '0', starred: '1' });
    const t = await thread(unread.threadId);
    expect(t).toMatchObject({ folder: 'inbox', lastAt: at, unread: true, starred: true });
    expect(t.messages).toHaveLength(1);
    expect(t.messages[0]).toMatchObject({ direction: 'in', status: 'received', at });
    expect(t.messages[0]!.events.map((e) => e.kind)).toContain('imported');
    expect((await list('inbox', t.mailboxId)).find((x) => x.id === t.id)).toMatchObject({ lastAt: at, unread: true });

    // The date parameter (IMAP INTERNALDATE) wins over the Date header, and read is the default.
    const internal = Date.UTC(2019, 4, 2, 9, 0);
    const read = await imported(raw({ subject: `Old read ${RUN}`, date: new Date(at).toUTCString(), body: 'Already seen.' }), { date: String(internal) });
    expect(await thread(read.threadId)).toMatchObject({ lastAt: internal, unread: false, starred: false });
  });

  it('treats a second upload of the same message as a duplicate and creates nothing', async () => {
    const body = raw({ subject: `Twice ${RUN}`, date: 'Tue, 2 Jun 2020 10:00:00 +0000', messageId: `twice-${RUN}@friends.example`, body: 'Once only.' });
    const first = await imported(body);
    const again = await upload(body, { folder: 'archive' });
    expect(again).toEqual({ status: 200, body: { status: 'duplicate' } });
    const t = await thread(first.threadId);
    expect(t.messages).toHaveLength(1);
    expect(t.folder).toBe('inbox');
  });

  it('puts a reply imported later in the same conversation, and an older message never moves it', async () => {
    const original = await imported(raw({ subject: `Garden ${RUN}`, date: 'Mon, 4 Jan 2021 09:00:00 +0000', messageId: `garden-${RUN}@friends.example`, body: 'First.' }));
    const replyAt = Date.UTC(2021, 0, 6, 12, 0);
    const reply = await imported(
      raw({ subject: `Re: Garden ${RUN}`, date: new Date(replyAt).toUTCString(), messageId: `garden-reply-${RUN}@friends.example`, inReplyTo: `garden-${RUN}@friends.example`, body: 'Newest words.' }),
    );
    expect(reply.threadId).toBe(original.threadId);
    expect(await thread(original.threadId)).toMatchObject({ lastAt: replyAt, snippet: 'Newest words.', messageCount: 2 });

    // A message dated between the two joins the conversation without becoming its latest.
    const middle = await imported(
      raw({ from: 'Sam Other <sam@friends.example>', subject: `Re: Garden ${RUN}`, date: 'Tue, 5 Jan 2021 08:00:00 +0000', inReplyTo: `garden-${RUN}@friends.example`, body: 'In between.' }),
      { folder: 'archive' },
    );
    expect(middle.threadId).toBe(original.threadId);
    const t = await thread(original.threadId);
    expect(t).toMatchObject({ lastAt: replyAt, snippet: 'Newest words.', fromEmail: 'lena@friends.example', folder: 'inbox', unread: false, messageCount: 3 });
    expect(t.messages.map((m) => m.text.trim())).toEqual(['First.', 'In between.', 'Newest words.']);
  });

  it('imports sent mail as sent, out of the inbox and searchable', async () => {
    const word = `quokka${RUN}`;
    const sent = await imported(
      raw({ from: `Old Me <${ADDRESS}>`, to: 'Lena Park <lena@friends.example>', subject: `Plans ${RUN}`, date: 'Fri, 8 Jan 2021 18:00:00 +0000', messageId: `plans-${RUN}@import-test.example`, body: `Shall we meet? ${word}` }),
      { folder: 'sent' },
    );
    const t = await thread(sent.threadId);
    expect(t.messages[0]).toMatchObject({ direction: 'out', status: 'sent', from: { email: ADDRESS }, to: [{ email: 'lena@friends.example' }], at: Date.UTC(2021, 0, 8, 18, 0) });
    expect(t.unread).toBe(false);
    expect((await list('sent', t.mailboxId)).some((x) => x.id === t.id)).toBe(true);
    expect((await list('inbox', t.mailboxId)).some((x) => x.id === t.id)).toBe(false);
    expect((await call<List>(`/api/search?q=${word}`)).body.data.map((x) => x.id)).toContain(t.id);

    // A reply that comes in later joins the sent conversation, which then shows in the inbox.
    const answer = await imported(raw({ subject: `Re: Plans ${RUN}`, date: 'Sat, 9 Jan 2021 09:00:00 +0000', inReplyTo: `plans-${RUN}@import-test.example`, body: 'Yes!' }), { read: '0' });
    expect(answer.threadId).toBe(sent.threadId);
    expect((await list('inbox', t.mailboxId)).some((x) => x.id === t.id)).toBe(true);
  });

  it('keeps archived mail out of the inbox', async () => {
    const a = await imported(raw({ subject: `Filed away ${RUN}`, date: 'Sun, 6 Oct 2019 07:00:00 +0000', body: 'Old news.' }), { folder: 'archive' });
    const t = await thread(a.threadId);
    expect(t.folder).toBe('archive');
    expect((await list('inbox', t.mailboxId)).some((x) => x.id === t.id)).toBe(false);
    expect((await list('archive', t.mailboxId)).some((x) => x.id === t.id)).toBe(true);
  });

  it('recognises a message without a Message-ID by its content', async () => {
    const body = raw({ subject: `No id ${RUN}`, date: 'Tue, 2 Mar 2021 12:00:00 +0000', messageId: null, body: 'Receipt.' });
    const first = await imported(body);
    expect((await upload(body)).body).toEqual({ status: 'duplicate' });
    expect((await thread(first.threadId)).messages).toHaveLength(1);
    // Different bytes are a different message.
    const other = await imported(body.replace('Receipt.', 'Another receipt.'));
    expect(other.messageId).not.toBe(first.messageId);
  });

  it('refuses people who are not an owner or admin, an empty body, and a missing address', async () => {
    const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
    const jwk = { ...(await exportJWK(publicKey)), kid: 'host-import', alg: 'EdDSA' };
    const hosted = { ...env, AI: undefined, AUTH_MODE: 'access', HOST_PUBLIC_KEYS: JSON.stringify([jwk]) } as Env;
    const token = await new SignJWT({ role: 'member', name: 'importer-member' }).setProtectedHeader({ alg: 'EdDSA', kid: 'host-import' })
      .setIssuer('host-app').setAudience('sadi-mail').setSubject('importer-member').setIssuedAt().setExpirationTime('5m').sign(privateKey);
    const denied = await upload(raw({ subject: 'Not allowed', date: 'Tue, 2 Mar 2021 12:00:00 +0000', body: 'x' }), {}, { env: hosted, headers: { authorization: `Bearer ${token}` } });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('forbidden');
    expect((await call<{ error: string }>('/api/import/status', { env: hosted, headers: { authorization: `Bearer ${token}` } })).status).toBe(403);

    const empty = await upload('');
    expect(empty.status).toBe(422);
    expect(empty.body.error).toBe('empty');

    const noAddress = await call<{ error: string }>('/api/import/message', { method: 'POST', body: raw({ subject: 'x', date: 'Tue, 2 Mar 2021 12:00:00 +0000', body: 'x' }) });
    expect(noAddress.status).toBe(422);
    expect(noAddress.body.error).toBe('invalid_address');
  });

  it('reports how much has been imported', async () => {
    await imported(raw({ subject: `Counted ${RUN}`, date: 'Tue, 2 Mar 2021 12:00:00 +0000', body: 'Count me.' }));
    const status = (await call<{ messages: number; bytes: number; lastImportedAt: number | null }>('/api/import/status')).body;
    expect(status.messages).toBeGreaterThan(0);
    expect(status.bytes).toBeGreaterThan(0);
    expect(status.lastImportedAt).toBeGreaterThan(Date.now() - 60_000);
  });
});

// ---------- the command-line importer's pure helpers ----------

interface Formats {
  splitMbox(input: string | Uint8Array): Uint8Array[];
  createMboxSplitter(): { push(chunk: Uint8Array): { start: number; end: number; bytes: Uint8Array }[]; end(): { start: number; end: number; bytes: Uint8Array }[] };
  unquoteMbox(bytes: Uint8Array): Uint8Array;
  maildirFlags(name: string): { seen: boolean; flagged: boolean; replied: boolean; draft: boolean; trashed: boolean };
  maildirDate(name: string): number | null;
  readHeaders(bytes: Uint8Array): { messageId: string | null; date: number | null; gmailLabels: string[] | null };
  mapFolder(name: string, options?: { specialUse?: string | null; overrides?: Map<string, string> }): string | null;
  parseMap(values: string[]): Map<string, string>;
  gmailFolder(labels: string[]): string;
}
// The helpers are plain JavaScript with no type declarations; a computed path keeps TypeScript from looking for them.
const FORMATS = '../scripts/lib/import-formats.mjs';
const formats = async () => (await import(/* @vite-ignore */ FORMATS)) as Formats;
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe('importer helpers', () => {
  const mbox = [
    'From someone@example.com Mon Jan  4 09:15:00 2021',
    'Subject: One',
    '',
    'Hello.',
    '>From the top: this line was quoted.',
    '>>From twice quoted.',
    'From here on, not a separator (no blank line before).',
    '',
    'From other@example.com Tue Jan  5 10:00:00 2021',
    'Subject: Two',
    '',
    'Second body.',
    '',
  ].join('\n');

  it('splits an mbox on its separator lines and undoes >From quoting', async () => {
    const { splitMbox } = await formats();
    const messages = splitMbox(mbox).map(text);
    expect(messages).toEqual([
      'Subject: One\n\nHello.\nFrom the top: this line was quoted.\n>From twice quoted.\nFrom here on, not a separator (no blank line before).\n',
      'Subject: Two\n\nSecond body.\n',
    ]);
  });

  it('gives the same messages however the file arrives in pieces, with offsets into the file', async () => {
    const { createMboxSplitter, unquoteMbox } = await formats();
    const bytes = new TextEncoder().encode(mbox);
    const splitter = createMboxSplitter();
    const found = [];
    for (let i = 0; i < bytes.length; i += 7) found.push(...splitter.push(bytes.slice(i, i + 7)));
    found.push(...splitter.end());
    expect(found).toHaveLength(2);
    for (const m of found) expect(text(bytes.subarray(m.start, m.end))).toBe(text(m.bytes));
    expect(text(unquoteMbox(found[0]!.bytes))).toContain('\nFrom the top');
  });

  it('reads CRLF mbox files and a last message with no newline at the end', async () => {
    const { splitMbox } = await formats();
    expect(splitMbox('From a@b Mon Jan  4 09:15:00 2021\r\nSubject: A\r\n\r\nBody\r\n\r\nFrom c@d Mon Jan  4 09:15:00 2021\r\nSubject: B\r\n\r\nEnd').map(text)).toEqual([
      'Subject: A\r\n\r\nBody\r\n',
      'Subject: B\r\n\r\nEnd',
    ]);
    expect(splitMbox('no separator at all\n')).toHaveLength(0);
  });

  it('reads Maildir flags and delivery time from the file name', async () => {
    const { maildirFlags, maildirDate } = await formats();
    expect(maildirFlags('1609459200.M1P1.host:2,FS')).toEqual({ seen: true, flagged: true, replied: false, draft: false, trashed: false });
    expect(maildirFlags('1609459200.M1P1.host:2,DRT')).toEqual({ seen: false, flagged: false, replied: true, draft: true, trashed: true });
    expect(maildirFlags('1609459200.M1P1.host!2,S').seen).toBe(true);
    expect(maildirFlags('1609545600.M2P1.host')).toEqual({ seen: false, flagged: false, replied: false, draft: false, trashed: false });
    expect(maildirDate('1609459200.M1P1.host:2,S')).toBe(Date.UTC(2021, 0, 1));
    expect(maildirDate('message.eml')).toBeNull();
  });

  it('reads Message-ID, Date and Gmail labels from the top of a message', async () => {
    const { readHeaders, gmailFolder } = await formats();
    const h = readHeaders(new TextEncoder().encode('X-Gmail-Labels: Inbox,"Starred",Unread\r\nMessage-ID:\r\n <abc@x.example>\r\nDate: Mon, 4 Jan 2021 09:15:00 +0000 (UTC)\r\n\r\nMessage-ID: <not-this@x>\r\n'));
    expect(h).toMatchObject({ messageId: 'abc@x.example', date: Date.UTC(2021, 0, 4, 9, 15), gmailLabels: ['Inbox', 'Starred', 'Unread'] });
    expect(gmailFolder(['Opened', 'Sent'])).toBe('Sent');
    expect(gmailFolder(['Category Updates'])).toBe('All Mail');
  });

  it('maps old folders to Sadi Mail folders, with overrides', async () => {
    const { mapFolder, parseMap } = await formats();
    expect(['INBOX', 'Sent Items', '[Gmail]/Sent Mail', 'INBOX.Sent', 'All Mail', 'Junk E-mail', 'Deleted Items', 'Projects/2024'].map((n) => mapFolder(n))).toEqual([
      'inbox', 'sent', 'sent', 'sent', 'archive', 'spam', 'trash', 'archive',
    ]);
    expect(mapFolder('Drafts')).toBeNull();
    expect(mapFolder('Gesendet', { specialUse: '\\Sent' })).toBe('sent');
    const overrides = parseMap(['Projects/2024=inbox', 'Sent=skip']);
    expect(mapFolder('projects/2024', { overrides })).toBe('inbox');
    expect(mapFolder('Sent', { overrides })).toBeNull();
    expect(() => parseMap(['Old=somewhere'])).toThrow(/not understood/);
  });
});
