import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ThreadDetail, ThreadSummary } from '../src/shared/types';
import { purgeOld } from '../src/worker/purge';
import { call, deliver, offline, post } from './helpers';

type List = { data: ThreadSummary[] };
const inView = async (view: string, id: string) => (await call<List>(`/api/threads?view=${view}&limit=100`)).body.data.some((t) => t.id === id);
const send = async (from: string, subject: string, extra: Record<string, unknown> = {}) => {
  const r = await deliver({ from, to: 'desk@spam-test.example', subject, body: `Body of ${subject}`, ...extra });
  if (r.outcome !== 'stored') throw new Error('not stored');
  return r.threadId!;
};

describe('spam filter', () => {
  it('files forged mail in Spam and leaves verified mail in the inbox', async () => {
    const forged = await send('Bank <alerts@bank-secure.example>', 'Verify your account', { auth: 'spf=fail; dkim=none; dmarc=fail' });
    const real = await send('Ana <ana@friend.example>', 'Lunch?', { auth: 'spf=pass; dkim=pass; dmarc=pass' });
    const softFail = await send('List <news@list.example>', 'Forwarded by a list', { auth: 'spf=pass; dkim=fail; dmarc=fail' });
    expect(await inView('spam', forged)).toBe(true);
    expect(await inView('inbox', forged)).toBe(false);
    expect(await inView('inbox', real)).toBe(true);
    expect(await inView('inbox', softFail)).toBe(true); // flagged, but not thrown away on one failed check
    const detail = (await call<ThreadDetail>(`/api/threads/${forged}`)).body;
    expect(detail.messages[0]!.events.some((e) => e.kind === 'spam')).toBe(true);
  });

  it('learns from Mark As Spam and from Not Spam', async () => {
    const first = await send('Pushy <deals@pushy.example>', 'Deal one');
    await call(`/api/threads/${first}/actions`, post({ action: 'spam' }));
    const second = await send('Pushy <deals@pushy.example>', 'Deal two');
    expect(await inView('spam', second)).toBe(true);

    await call(`/api/threads/${second}/actions`, post({ action: 'inbox' })); // Not Spam
    const third = await send('Pushy <deals@pushy.example>', 'Deal three', { auth: 'spf=fail; dkim=none; dmarc=fail' });
    expect(await inView('inbox', third)).toBe(true); // a cleared sender is never filed as spam
  });
});

describe('trash', () => {
  it('deletes forever only from Trash or Spam, removing the stored files too', async () => {
    const r = await deliver({ from: 'x@old.example', to: 'desk@spam-test.example', subject: 'Delete me', body: 'bye', attachment: { filename: 'a.pdf', content: '%PDF' } });
    if (r.outcome !== 'stored') throw new Error('not stored');
    expect((await call<{ error: string }>(`/api/threads/${r.threadId}/delete-forever`, post({}))).body.error).toBe('not_in_trash');
    await call(`/api/threads/${r.threadId}/actions`, post({ action: 'trash' }));
    expect((await call<{ ok: boolean }>(`/api/threads/${r.threadId}/delete-forever`, post({}))).body.ok).toBe(true);
    expect((await call<unknown>(`/api/threads/${r.threadId}`)).status).toBe(404);
    expect(await env.MAIL.head(r.rawKey)).toBeNull();
    expect((await env.MAIL.list({ prefix: `att/${r.id}/` })).objects).toHaveLength(0);
    expect((await call<List>('/api/search?q=Delete')).body.data.some((t) => t.id === r.threadId)).toBe(false);
  });

  it('empties Trash, and clears out anything left there for 30 days', async () => {
    const a = await send('a@x.example', 'Trash A');
    const b = await send('b@x.example', 'Trash B');
    for (const id of [a, b]) await call(`/api/threads/${id}/actions`, post({ action: 'trash' }));
    expect(await purgeOld(offline, Date.now() + 29 * 86_400_000)).toBe(0);
    await env.DB.prepare('UPDATE thread SET moved_at = ? WHERE id = ?').bind(Date.now() - 31 * 86_400_000, a).run();
    expect(await purgeOld(offline)).toBeGreaterThanOrEqual(1);
    expect((await call<unknown>(`/api/threads/${a}`)).status).toBe(404);
    expect((await call<unknown>(`/api/threads/${b}`)).status).toBe(200);
    const emptied = await call<{ removed: number }>('/api/folders/trash/empty', post({}));
    expect(emptied.body.removed).toBeGreaterThanOrEqual(1);
    expect((await call<unknown>(`/api/threads/${b}`)).status).toBe(404);
    expect((await call<{ error: string }>('/api/folders/inbox/empty', post({}))).body.error).toBe('bad_folder');
  });
});

describe('designed HTML mail', () => {
  it('shows pictures embedded in the message and keeps the layout markup', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const b = 'rel-b';
    const raw = [
      'From: Shop <news@shop.example>', 'To: desk@spam-test.example', 'Subject: Designed', 'Message-ID: <designed-1@shop.example>', 'MIME-Version: 1.0',
      `Content-Type: multipart/related; boundary="${b}"`, '', `--${b}`, 'Content-Type: text/html; charset=utf-8', '',
      '<table width="600" style="border-collapse:collapse"><tr><td style="background:#101828;color:#fff;padding:24px"><img src="cid:logo@shop" width="120" alt="Shop"><h1 style="font-size:28px">Winter Sale</h1></td></tr><tr><td><a href="https://shop.example/sale" style="background:#4f46e5;color:#fff;padding:12px 20px;border-radius:8px">Shop Now</a></td></tr></table>',
      `--${b}`, 'Content-Type: image/png', 'Content-Transfer-Encoding: base64', 'Content-ID: <logo@shop>', 'Content-Disposition: inline; filename="logo.png"', '', png, `--${b}--`, '',
    ].join('\r\n');
    const { receive } = await import('../src/worker/ingest');
    const r = await receive(offline, { bytes: new TextEncoder().encode(raw).buffer as ArrayBuffer, envelopeFrom: 'news@shop.example', envelopeTo: 'desk@spam-test.example' });
    if (r.outcome !== 'stored') throw new Error('not stored');
    const m = (await call<ThreadDetail>(`/api/threads/${r.threadId}`)).body.messages[0]!;
    expect(m.html).toContain(`src="data:image/png;base64,${png}"`);
    expect(m.html).toContain('border-collapse:collapse');
    expect(m.html).toContain('background:#4f46e5');
    expect(m.html).toContain('href="https://shop.example/sale"');
    expect(m.hasRemoteImages).toBe(false);
    expect(m.attachments.filter((a) => !a.inline)).toHaveLength(0);
  });
});
