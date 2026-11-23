import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { parseRecipients, personalise } from '../src/shared/bulk';
import type { Bootstrap, BulkJobInfo, ThreadSummary } from '../src/shared/types';
import { runBulk } from '../src/worker/bulk';
import { call, deliver, offline, post } from './helpers';

describe('bulk sending', () => {
  it('reads a pasted list in every common shape and drops repeats', () => {
    const r = parseRecipients('a@x.example\nRima Akter <rima@x.example>\nben@x.example, Ben Karim\n"Chen", chen@x.example\nA@X.example\nnot an address');
    expect(r.people).toEqual([{ name: '', email: 'a@x.example' }, { name: 'Rima Akter', email: 'rima@x.example' }, { name: 'Ben Karim', email: 'ben@x.example' }, { name: 'Chen', email: 'chen@x.example' }]);
    expect(r.duplicates).toBe(1);
    expect(r.invalid).toEqual(['not an address']);
  });

  it('fills in each person, and escapes names inside HTML', () => {
    expect(personalise('Hi {{first_name}} ({{ email }})', { name: 'Rima Akter', email: 'r@x.example' })).toBe('Hi Rima (r@x.example)');
    expect(personalise('Hi {{first_name}}', { name: '', email: 'r@x.example' })).toBe('Hi there');
    expect(personalise('<p>{{name}}</p>', { name: '<b>x</b>', email: 'r@x.example' }, true)).toBe('<p>&lt;b&gt;x&lt;/b&gt;</p>');
  });

  it('sends each person their own copy, a few per minute, and can be cancelled', async () => {
    await deliver({ from: 'a@b.example', to: 'news@bulk-test.example', subject: 'Makes the address', body: 'hi' });
    const from = (await call<Bootstrap>('/api/bootstrap')).body.mailboxes.flatMap((m) => m.addresses).find((a) => a.email === 'news@bulk-test.example')!;
    const list = Array.from({ length: 7 }, (_, i) => `Person ${i} <p${i}@bulk-far.example>`).join('\n');
    expect((await call<{ error: string }>('/api/bulk', post({ fromAddressId: from.id, recipients: 'one@x.example', subject: 's', text: 't' }))).body.error).toBe('too_few');
    expect((await call<{ error: string }>('/api/bulk', post({ fromAddressId: from.id, recipients: `${list}\nbroken`, subject: 's', text: 't' }))).body.error).toBe('invalid_recipient');
    const made = (await call<BulkJobInfo>('/api/bulk', post({ fromAddressId: from.id, recipients: list, subject: 'News for {{first_name}}', text: 'Hello {{name}}', perMinute: 5, startAt: Date.now() + 60_000 }))).body;
    expect([made.total, made.done, made.status]).toEqual([7, 0, 'running']);

    await runBulk(offline); // not yet time
    expect((await call<{ data: BulkJobInfo[] }>('/api/bulk')).body.data[0]!.done).toBe(0);
    await runBulk(offline, Date.now() + 61_000);
    let job = (await call<{ data: BulkJobInfo[] }>('/api/bulk')).body.data[0]!;
    expect([job.done, job.sent, job.status]).toEqual([5, 5, 'running']);
    const sent = (await call<{ data: ThreadSummary[] }>('/api/threads?view=sent')).body.data.filter((t) => t.subject === 'News for Person');
    expect(sent).toHaveLength(5);
    const one = await env.DB.prepare("SELECT to_json, cc_json, body_text FROM message WHERE subject = 'News for Person' LIMIT 1").first<{ to_json: string; cc_json: string; body_text: string }>();
    expect(JSON.parse(one!.to_json)).toHaveLength(1); // nobody sees anyone else
    expect(one!.body_text).toMatch(/^Hello Person \d$/);

    await call(`/api/bulk/${made.id}/cancel`, post({}));
    await runBulk(offline, Date.now() + 200_000);
    job = (await call<{ data: BulkJobInfo[] }>('/api/bulk')).body.data[0]!;
    expect([job.done, job.sent, job.status]).toEqual([5, 5, 'cancelled']);
  });
});
