import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ProfileFields } from '../src/shared/profile';
import type { Env } from '../src/worker/util';
import { call, deliver } from './helpers';

const json = (body: unknown) => ({ method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('the information card', () => {
  it('saves the card, renames the person and refuses an empty name', async () => {
    const saved = await call<{ profile: ProfileFields; forAi: string }>('/api/me/profile', json({ name: 'Rima Akter', title: 'Buyer', company: 'Fieldwork', phone: '+880 1700 000000', tone: 'formal', about: 'I order paper.\nI keep mail short.', junk: 'x' }));
    expect(saved.status).toBe(200);
    expect(saved.body.profile.tone).toBe('formal');
    expect(saved.body.forAi).toContain('Role: Buyer at Fieldwork');
    expect(saved.body.forAi).toContain('Preferred tone: formal and polite');
    const read = await call<{ profile: ProfileFields }>('/api/me/profile');
    expect(read.body.profile.name).toBe('Rima Akter');
    expect((await call<{ user: { name: string } }>('/api/bootstrap')).body.user.name).toBe('Rima Akter');
    expect((await call<{ error: string }>('/api/me/profile', json({ name: '  ' }))).body.error).toBe('no_name');
  });

  it('gives the card to the AI when it writes a reply, and signs with the name on it', async () => {
    await call('/api/me/profile', json({ name: 'Rima Akter', phone: '+880 1700 000000' }));
    const r = await deliver({ from: 'Vincent <vincent@print.example>', to: 'orders@profile-test.example', subject: 'Call me', body: 'What number can I reach you on?' });
    if (r.outcome !== 'stored') throw new Error('not stored');
    const seen: string[] = [];
    const AI = { run: async (_m: string, input: unknown) => { seen.push((input as { messages: { role: string; content: string }[] }).messages.find((m) => m.role === 'system')!.content); return { response: 'Hello Vincent' }; } };
    const withAi = { ...env, AI, MAIL_SECRET_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))) } as unknown as Env;
    const res = await call<{ text: string }>(`/api/threads/${r.threadId}/ai/reply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', env: withAi });
    expect(res.status).toBe(200);
    expect(seen[0]).toContain('Phone: +880 1700 000000');
    expect(seen[0]).toContain('signed exactly "Rima Akter"');
  });
});
