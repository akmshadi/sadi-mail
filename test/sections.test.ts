import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ThreadSummary } from '../src/shared/types';
import { sectionOf } from '../src/worker/section';
import { call, deliver, post } from './helpers';

const h = (headers: Record<string, string>) => (name: string) => headers[name] ?? null;
type List = { data: ThreadSummary[] };

describe('inbox sections', () => {
  it('sorts by sender and headers, with no AI call', () => {
    expect(sectionOf({ fromEmail: 'ana@friend.example', subject: 'Lunch on Friday?', header: h({}) })).toBe('primary');
    expect(sectionOf({ fromEmail: 'notification@facebookmail.com', subject: 'You have a new friend request', header: h({ 'list-unsubscribe': '<https://x>' }) })).toBe('social');
    expect(sectionOf({ fromEmail: 'messages-noreply@linkedin.com', subject: 'New message', header: h({}) })).toBe('social');
    expect(sectionOf({ fromEmail: 'news@shop.example', subject: 'Winter sale: 40% off everything', header: h({ 'list-unsubscribe': '<https://x>' }) })).toBe('promotions');
    expect(sectionOf({ fromEmail: 'issue@themargin.example', subject: 'Issue 112: Pricing for small studios', header: h({ 'list-unsubscribe': '<https://x>', 'list-id': '<margin.example>' }) })).toBe('promotions');
    expect(sectionOf({ fromEmail: 'orders@shop.example', subject: 'Your order has shipped', header: h({ 'list-unsubscribe': '<https://x>' }) })).toBe('updates');
    expect(sectionOf({ fromEmail: 'no-reply@bank.example', subject: 'Your verification code', header: h({}) })).toBe('updates');
    expect(sectionOf({ fromEmail: 'noreply@github.example', subject: 'Build finished', header: h({}) })).toBe('updates');
    expect(sectionOf({ fromEmail: 'dev@googlegroups.com', subject: 'Re: release plan', header: h({ 'list-id': '<dev.googlegroups.com>' }) })).toBe('forums');
    expect(sectionOf({ fromEmail: 'sam@lists.project.example', subject: 'Re: patch review', header: h({ 'list-id': '<dev.project>', 'list-post': '<mailto:dev@lists.project.example>' }) })).toBe('forums');
    // A real person who happens to write about an invoice stays in Primary.
    expect(sectionOf({ fromEmail: 'vincent@moreauprint.example', subject: 'Invoice INV-2291', header: h({}) })).toBe('primary');
  });

  it('files new mail in its section, counts unread per section, and learns from a move', async () => {
    const mail = (from: string, subject: string) => deliver({ from, to: 'desk@sections-test.example', subject, body: 'x' }).then((r) => (r.outcome === 'stored' ? r.threadId! : ''));
    const friend = await mail('Ana <ana@friend-s.example>', 'Lunch?');
    const code = await mail('no-reply@bank-s.example', 'Your verification code');
    const inSection = async (s: string) => (await call<List>(`/api/threads?view=inbox&section=${s}&limit=100`)).body.data.map((t) => t.id);
    expect(await inSection('primary')).toContain(friend);
    expect(await inSection('primary')).not.toContain(code);
    expect(await inSection('updates')).toContain(code);
    expect((await call<{ error: string }>('/api/threads?view=inbox&section=nope')).body.error).toBe('bad_section');

    const counts = (await call<{ sections: Record<string, number> }>('/api/counts')).body.sections;
    expect(counts.primary).toBeGreaterThanOrEqual(1);
    expect(counts.updates).toBeGreaterThanOrEqual(1);

    // Move the bank's mail to Primary: this message moves, and the next one from that sender follows.
    expect((await call<ThreadSummary>(`/api/threads/${code}/actions`, post({ action: 'section', section: 'primary' }))).body.section).toBe('primary');
    const next = await mail('no-reply@bank-s.example', 'Your statement is ready');
    expect(await inSection('primary')).toEqual(expect.arrayContaining([code, next]));
    expect((await call<{ error: string }>(`/api/threads/${code}/actions`, post({ action: 'section', section: 'junk' }))).body.error).toBe('bad_section');
  });

  it('filters a list by time range, sender and attachments', async () => {
    const a = await deliver({ from: 'Ana Filter <ana@filter-a.example>', to: 'f@filter-test.example', subject: 'Filter one', body: 'x', attachment: { filename: 'a.pdf', content: 'AAAA' } });
    await deliver({ from: 'Ben <ben@filter-b.example>', to: 'f@filter-test.example', subject: 'Filter two', body: 'y' });
    if (a.outcome !== 'stored') throw new Error('not stored');
    await env.DB.prepare('UPDATE thread SET last_at = ? WHERE id = ?').bind(Date.UTC(2024, 5, 1, 12), a.threadId).run();
    const subjects = async (q: string) => (await call<{ data: ThreadSummary[] }>(`/api/threads?view=inbox&section=primary&${q}`)).body.data.map((t) => t.subject).filter((s) => s.startsWith('Filter'));
    expect(await subjects(`after=${Date.UTC(2024, 0, 1)}&before=${Date.UTC(2025, 0, 1)}`)).toEqual(['Filter one']);
    expect(await subjects(`after=${Date.UTC(2025, 0, 1)}`)).toEqual(['Filter two']);
    expect(await subjects('from=FILTER-A')).toEqual(['Filter one']);
    expect(await subjects('from=ben')).toEqual(['Filter two']);
    expect(await subjects('files=1')).toEqual(['Filter one']);
    expect(await subjects('from=100%25')).toEqual([]);
  });
});
