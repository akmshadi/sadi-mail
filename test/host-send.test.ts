import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { SendResult, ThreadDetail } from '../src/shared/types';
import type { Env } from '../src/worker/util';
import { call, deliver } from './helpers';

const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** What a host application sends: the From address by email, a Reply-To, a header, a file and its own key. */
describe('sending for a host application', () => {
  it('sends by From email with Reply-To, an allowed header and a file, once per idempotency key', async () => {
    // Mail to an address creates it, which is how an address exists in this test installation.
    await deliver({ from: 'someone@sender.example', to: 'noreply@fieldwork.example', subject: 'hello', body: 'x' });
    const seen: Array<Record<string, unknown>> = [];
    const live: Env = { ...env, SEND_MODE: 'cloudflare', EMAIL: { send: async (m: Record<string, unknown>) => { seen.push(m); return { messageId: `<cf-${seen.length}@fieldwork.example>` }; } } } as unknown as Env;
    const body = {
      fromEmail: 'NoReply@fieldwork.example',
      to: [{ name: '', email: 'shop@customer.example' }],
      subject: 'Your receipt',
      text: 'Thank you.',
      html: '<p>Thank you.</p>',
      replyTo: 'support@fieldwork.example',
      headers: { 'List-Unsubscribe': '<https://fieldwork.example/u/1>' },
      attachments: [{ filename: 'receipt.pdf', mime: 'application/pdf', contentBase64: btoa('%PDF-1.4 test') }],
      idempotencyKey: 'receipt-42',
    };
    const first = await call<SendResult>('/api/send', { ...post(body), env: live });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('sent');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ replyTo: 'support@fieldwork.example', subject: 'Your receipt', headers: { 'List-Unsubscribe': '<https://fieldwork.example/u/1>' } });
    expect((seen[0]!.attachments as Array<{ filename: string; content: string }>)[0]).toMatchObject({ filename: 'receipt.pdf', content: btoa('%PDF-1.4 test') });

    const again = await call<SendResult>('/api/send', { ...post(body), env: live });
    expect(again.body).toMatchObject({ messageId: first.body.messageId, status: 'sent' });
    expect(seen).toHaveLength(1);

    const thread = (await call<ThreadDetail>(`/api/threads/${first.body.threadId}`)).body;
    expect(thread.messages.at(-1)).toMatchObject({ direction: 'out', status: 'sent', from: { email: 'noreply@fieldwork.example' } });
  });

  it('refuses a header that could change the sender, and a From address that does not exist', async () => {
    await deliver({ from: 'someone@sender.example', to: 'noreply@fieldwork.example', subject: 'hello', body: 'x' });
    const base = { fromEmail: 'noreply@fieldwork.example', to: [{ name: '', email: 'a@b.example' }], subject: 's', text: 't' };
    expect((await call('/api/send', post({ ...base, headers: { From: 'ceo@bank.example' } }))).status).toBe(422);
    expect((await call('/api/send', post({ ...base, headers: { 'X-Note': 'a\r\nBcc: x@y.example' } }))).status).toBe(422);
    expect((await call('/api/send', post({ ...base, fromEmail: 'nobody@elsewhere.example' }))).status).toBe(404);
  });
});
