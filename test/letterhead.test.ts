import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type EmailDesign, parseLetterhead, renderDesign, renderLetter, withLetterhead } from '../src/shared/design';
import type { Bootstrap } from '../src/shared/types';
import { serveMedia } from '../src/worker/media';
import { call, deliver, offline } from './helpers';

const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
const design = (layout: 'center' | 'left'): EmailDesign => ({ version: 1, settings: { ...DEFAULT_SETTINGS, layout }, blocks: [{ id: 'a', type: 'header', brand: 'Old', logo: '', align: 'center' }, { id: 'b', type: 'text', text: 'Body', align: 'left' }, { id: 'c', type: 'footer', text: 'Old foot', address: '' }] });

describe('pictures, letterhead and layout', () => {
  it('stores an uploaded picture and serves it publicly at an address that cannot be guessed', async () => {
    expect((await call<{ error: string }>('/api/media', { method: 'PUT', headers: { 'content-type': 'text/html' }, body: '<script>' })).body.error).toBe('bad_image');
    const up = await call<{ id: string; url: string }>('/api/media', { method: 'PUT', headers: { 'content-type': 'image/png', 'x-file-name': 'logo.png' }, body: PNG });
    expect(up.body.url).toMatch(/^http:\/\/localhost\/media\/[a-f0-9]{32}\.png$/);
    const got = await serveMedia(offline, new URL(up.body.url).pathname);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG);
    expect((await serveMedia(offline, `/media/${'0'.repeat(32)}.png`)).status).toBe(404);
    expect((await serveMedia(offline, '/media/../avatar/x')).status).toBe(404);
    await call(`/api/media/${up.body.id}`, { method: 'DELETE' });
    expect((await serveMedia(offline, new URL(up.body.url).pathname)).status).toBe(404);
  });

  it('saves a letterhead on a mailbox and returns it clean', async () => {
    await deliver({ from: 'a@b.example', to: 'hi@letter-test.example', subject: 'Makes the mailbox', body: 'x' });
    const box = (await call<Bootstrap>('/api/bootstrap')).body.mailboxes.find((m) => m.addresses.some((a) => a.email === 'hi@letter-test.example'))!;
    expect(box.letterhead.on).toBe(false);
    await call(`/api/mailboxes/${box.id}/letterhead`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: true, brand: 'Northwind <b>', logo: 'javascript:alert(1)', tone: 'accent', layout: 'left', accent: 'red', footer: 'Thanks', junk: 1 }) });
    const saved = (await call<Bootstrap>('/api/bootstrap')).body.mailboxes.find((m) => m.id === box.id)!.letterhead;
    expect(saved).toMatchObject({ on: true, brand: 'Northwind <b>', logo: '', tone: 'accent', layout: 'left', accent: DEFAULT_SETTINGS.accent, footer: 'Thanks' });
    expect((await env.DB.prepare('SELECT letterhead_json FROM mailbox WHERE id = ?').bind(box.id).first<{ letterhead_json: string }>())!.letterhead_json).not.toContain('junk');
  });

  it('centres the email as a card, or sets it flush left like a letter', () => {
    const centre = renderDesign(design('center'));
    const left = renderDesign(design('left'));
    expect(centre).toContain('align="center" style="padding:24px 12px;"');
    expect(left).toContain('align="left" style="padding:0;"');
    expect(left).toContain('border-radius:0px');
    expect(left).not.toContain(`background-color:${DEFAULT_SETTINGS.background}`);
  });

  it('puts the company header and footer round a design and round an ordinary message', () => {
    const l = parseLetterhead({ on: true, brand: 'Fieldwork & Co', tagline: 'Print studio', tone: 'light', footer: 'Reply to reach us.', address: '1 Mill Road', accent: '#0F9D8A' });
    const d = withLetterhead(design('center'), l);
    expect(d.blocks.map((b) => b.type)).toEqual(['header', 'text', 'footer']);
    const html = renderDesign(d);
    expect(html).toContain('Fieldwork &amp; Co');
    expect(html).toContain('Print studio');
    expect(html).not.toContain('Old foot');
    const letter = renderLetter('<p>Hello <b>Rima</b></p>', l);
    expect(letter).toContain('<p>Hello <b>Rima</b></p>');
    expect(letter).toContain('1 Mill Road');
    expect(letter.indexOf('Fieldwork &amp; Co')).toBeLessThan(letter.indexOf('Hello <b>Rima</b>'));
    expect(letter).not.toContain('@@sadi-mail');
  });
});
