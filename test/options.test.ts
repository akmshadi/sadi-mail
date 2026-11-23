import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { AttachmentInfo, Bootstrap, DraftDetail, LabelInfo, SendResult, TemplateInfo, ThreadDetail, ThreadSummary } from '../src/shared/types';
import { deliverDue } from '../src/worker/send';
import { call, deliver, offline, post } from './helpers';

type List = { data: ThreadSummary[] };
const list = async (query: string) => (await call<List>(`/api/threads?${query}`)).body.data;

async function arrive(subject: string, from = 'Sam Client <sam@client.example>') {
  const r = await deliver({ from, to: 'desk@options.example', subject, body: `Body of ${subject}`, messageId: `${subject.replace(/\W/g, '')}@client.example` });
  if (r.outcome !== 'stored') throw new Error('not stored');
  return r.threadId!;
}
const fromAddress = async () => (await call<Bootstrap>('/api/bootstrap')).body.mailboxes.flatMap((m) => m.addresses).find((a) => a.email === 'desk@options.example')!;

describe('drafts', () => {
  it('saves a new message as a draft, updates it, and lists it only under Drafts', async () => {
    await arrive('Seed the mailbox');
    const from = await fromAddress();
    const made = await call<{ id: string; threadId: string }>('/api/drafts', post({ fromAddressId: from.id, to: [{ name: '', email: 'ana@x.example' }, { name: '', email: 'half-typed' }], cc: [], bcc: [{ name: '', email: 'boss@x.example' }], subject: 'Quote', text: 'First version', mode: 'new' }));
    expect(made.status).toBe(200);
    await call('/api/drafts', post({ id: made.body.id, fromAddressId: from.id, to: [{ name: '', email: 'ana@x.example' }], cc: [], bcc: [{ name: '', email: 'boss@x.example' }], subject: 'Quote for cards', text: 'Second version', mode: 'new' }));

    const draft = (await call<DraftDetail>(`/api/drafts/${made.body.id}`)).body;
    expect(draft).toMatchObject({ subject: 'Quote for cards', text: 'Second version', to: [{ email: 'ana@x.example' }], bcc: [{ email: 'boss@x.example' }], cc: [], mode: 'new' });
    expect((await list('view=drafts')).map((t) => t.subject)).toContain('Quote for cards');
    for (const view of ['inbox', 'sent', 'archive']) expect((await list(`view=${view}`)).some((t) => t.id === made.body.threadId)).toBe(false);
  });

  it('sends a draft with its attachment, and the draft is gone', async () => {
    const from = await fromAddress();
    const made = (await call<{ id: string; threadId: string }>('/api/drafts', post({ fromAddressId: from.id, to: [{ name: '', email: 'ana@x.example' }], cc: [], bcc: [], subject: 'With a file', text: 'See attached.', mode: 'new' }))).body;
    const file = await call<AttachmentInfo>(`/api/drafts/${made.id}/attachments?filename=${encodeURIComponent('Quote 2026.pdf')}`, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: new TextEncoder().encode('%PDF-test') });
    expect(file.body).toMatchObject({ filename: 'Quote 2026.pdf', size: 9, mime: 'application/pdf' });
    expect((await call<{ error: string }>(`/api/drafts/${made.id}/attachments?filename=x`, { method: 'PUT', body: new Uint8Array(0) })).body.error).toBe('empty_file');

    const sent = (await call<SendResult>('/api/send', post({ fromAddressId: from.id, to: [{ name: '', email: 'ana@x.example' }], subject: 'With a file', text: 'See attached.', draftId: made.id }))).body;
    expect(sent).toMatchObject({ status: 'dry_run', threadId: made.threadId });
    expect((await call<unknown>(`/api/drafts/${made.id}`)).status).toBe(404);
    const thread = (await call<ThreadDetail>(`/api/threads/${made.threadId}`)).body;
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]).toMatchObject({ status: 'dry_run', attachments: [{ filename: 'Quote 2026.pdf' }] });
    expect(thread).toMatchObject({ subject: 'With a file', hasAttachment: true });
    expect((await list('view=drafts')).some((t) => t.id === made.threadId)).toBe(false);
    expect((await list('view=sent')).some((t) => t.id === made.threadId)).toBe(true);
  });

  it('keeps a reply draft inside its conversation and deletes cleanly', async () => {
    const threadId = await arrive('Reply draft');
    const from = await fromAddress();
    const original = (await call<ThreadDetail>(`/api/threads/${threadId}`)).body.messages[0]!;
    const made = (await call<{ id: string; threadId: string }>('/api/drafts', post({ fromAddressId: from.id, to: [original.from], cc: [], bcc: [], subject: 'Re: Reply draft', text: 'Thinking…', inReplyToMessageId: original.id, mode: 'reply' }))).body;
    expect(made.threadId).toBe(threadId);
    expect((await call<ThreadDetail>(`/api/threads/${threadId}`)).body.messages.map((m) => m.status)).toEqual(['received', 'draft']);
    expect((await call<{ ok: boolean }>(`/api/drafts/${made.id}`, { method: 'DELETE' })).body.ok).toBe(true);
    expect((await call<ThreadDetail>(`/api/threads/${threadId}`)).body.messages).toHaveLength(1);
  });
});

describe('undo send', () => {
  it('holds the message, lets it be taken back as a draft, and never sends it twice', async () => {
    const from = await fromAddress();
    const body = { fromAddressId: from.id, to: [{ name: '', email: 'ana@x.example' }], subject: 'Oops', text: 'Wrong person', undoSeconds: 10 };
    const held = (await call<SendResult>('/api/send', post(body))).body;
    expect(held.status).toBe('scheduled');
    expect(await deliverDue(offline, Date.now())).toBe(0); // not due yet

    const back = await call<{ draftId: string }>(`/api/messages/${held.messageId}/cancel`, post({}));
    expect(back.body.draftId).toBe(held.messageId);
    expect((await call<DraftDetail>(`/api/drafts/${held.messageId}`)).body.text).toBe('Wrong person');
    await deliverDue(offline, Date.now() + 60_000);
    expect((await call<ThreadDetail>(`/api/threads/${held.threadId}`)).body.messages[0]!.status).toBe('draft');

    const second = (await call<SendResult>('/api/send', post({ ...body, subject: 'Let it go' }))).body;
    await Promise.all([deliverDue(offline, Date.now() + 60_000), deliverDue(offline, Date.now() + 60_000)]);
    const events = await env.DB.prepare("SELECT COUNT(*) AS n FROM message_event WHERE message_id = ? AND kind = 'dry-run'").bind(second.messageId).first<{ n: number }>();
    expect(events!.n).toBe(1);
    expect((await call<{ error: string }>(`/api/messages/${second.messageId}/cancel`, post({}))).body.error).toBe('too_late');
  });
});

describe('labels, snooze, templates, contacts', () => {
  it('labels a conversation and filters by label', async () => {
    const id = await arrive('Label me');
    const label = (await call<LabelInfo>('/api/labels', post({ name: 'Invoices', color: '#4F46E5' }))).body;
    expect((await call<{ error: string }>('/api/labels', post({ name: 'invoices' }))).body.error).toBe('exists');
    expect((await call<{ data: LabelInfo[] }>(`/api/threads/${id}/labels`, post({ labelId: label.id, on: true }))).body.data).toEqual([label]);
    const found = await list(`view=inbox&label=${label.id}`);
    expect(found.map((t) => t.id)).toEqual([id]);
    expect(found[0]!.labels).toEqual([label]);
    await call(`/api/threads/${id}/labels`, post({ labelId: label.id, on: false }));
    expect(await list(`view=inbox&label=${label.id}`)).toHaveLength(0);
  });

  it('snoozes a conversation out of the inbox until its time', async () => {
    const id = await arrive('Snooze me');
    const until = Date.now() + 3_600_000;
    expect((await call<ThreadSummary>(`/api/threads/${id}/actions`, post({ action: 'snooze', until }))).body.snoozedUntil).toBe(until);
    expect((await list('view=inbox')).some((t) => t.id === id)).toBe(false);
    expect((await list('view=snoozed')).some((t) => t.id === id)).toBe(true);
    await call(`/api/threads/${id}/actions`, post({ action: 'inbox' }));
    expect((await list('view=inbox')).some((t) => t.id === id)).toBe(true);
  });

  it('saves, edits and removes templates', async () => {
    const made = (await call<TemplateInfo>('/api/templates', post({ name: 'Thanks', subject: 'Thank you', body: 'Thank you for your order.' }))).body;
    await call('/api/templates', post({ id: made.id, name: 'Thanks', subject: 'Thank you', body: 'Thank you for your order!' }));
    expect((await call<{ data: TemplateInfo[] }>('/api/templates')).body.data.find((t) => t.id === made.id)!.body).toBe('Thank you for your order!');
    expect((await call<{ error: string }>('/api/templates', post({ name: 'Empty', body: ' ' }))).body.error).toBe('empty');
    await call(`/api/templates/${made.id}`, { method: 'DELETE' });
    expect((await call<{ data: TemplateInfo[] }>('/api/templates')).body.data.some((t) => t.id === made.id)).toBe(false);
  });

  it('suggests people from past mail, never your own addresses or unverified senders', async () => {
    await arrive('From a real person', 'Priya Nair <priya@nair.example>');
    await deliver({ from: 'Priya Fake <priya@lookalike.example>', to: 'desk@options.example', subject: 'Fake', body: 'x', auth: 'spf=fail; dkim=none; dmarc=fail' });
    const found = (await call<{ data: { name: string; email: string }[] }>('/api/contacts?q=pri')).body.data;
    expect(found).toContainEqual({ name: 'Priya Nair', email: 'priya@nair.example' });
    expect(found.some((p) => p.email === 'priya@lookalike.example')).toBe(false);
    expect((await call<{ data: unknown[] }>('/api/contacts?q=desk')).body.data).toHaveLength(0);
    expect((await call<{ data: { email: string }[] }>('/api/contacts?q=ana')).body.data.map((p) => p.email)).toContain('ana@x.example');
  });
});

describe('signatures', () => {
  it('builds a signature from fields, escapes what was typed, and returns it with the address', async () => {
    const { signatureHtml, signatureText, parseSignature } = await import('../src/shared/signature');
    const f = parseSignature({ closing: 'Best regards,', name: 'Sam <b>Lee</b>', title: 'Director', company: 'Fieldwork', phone: '+880 1700 000000', website: 'fieldwork.example', logoUrl: 'javascript:alert(1)', style: 'divider' });
    expect(signatureText(f)).toBe('Best regards,\nSam <b>Lee</b>\nDirector, Fieldwork\n+880 1700 000000\nfieldwork.example');
    const html = signatureHtml(f);
    expect(html).toContain('Sam &lt;b&gt;Lee&lt;/b&gt;');
    expect(html).toContain('href="https://fieldwork.example"');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<img');
    expect(signatureHtml(parseSignature({ style: 'compact' }))).toBe('');

    const from = await fromAddress();
    await call(`/api/addresses/${from.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signatureFields: f }) });
    const saved = await fromAddress();
    expect(saved.signature).toContain('Director, Fieldwork');
    expect(saved.signatureHtml).toContain('border-left:3px solid');
    expect(saved.signatureFields).toMatchObject({ name: 'Sam <b>Lee</b>', style: 'divider', logoUrl: 'javascript:alert(1)' });
  });
});
