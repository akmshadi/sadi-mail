import { describe, expect, it } from 'vitest';
import { type EmailDesign, DEFAULT_SETTINGS, STARTERS, designToText, newBlock, parseDesign, renderDesign, starter } from '../src/shared/design';
import type { Bootstrap, DraftDetail, SendResult, TemplateInfo, ThreadDetail } from '../src/shared/types';
import { cleanHtml } from '../src/worker/sanitize';
import { call, deliver, post } from './helpers';

const ADDRESS = 'desk@design-test.example';

const design = (blocks: EmailDesign['blocks'], settings: Partial<EmailDesign['settings']> = {}): EmailDesign => ({ version: 1, settings: { ...DEFAULT_SETTINGS, ...settings }, blocks });

async function fromAddress() {
  const find = async () => (await call<Bootstrap>('/api/bootstrap')).body.mailboxes.flatMap((m) => m.addresses).find((a) => a.email === ADDRESS);
  if (!(await find())) await deliver({ from: 'Seed <seed@client.example>', to: ADDRESS, subject: 'Seed the design mailbox', body: 'Hello' });
  return (await find())!;
}

describe('renderDesign', () => {
  it('escapes everything a person types', () => {
    const html = renderDesign(design([
      { id: 'h', type: 'heading', text: '<script>alert(1)</script> & "quotes"', level: 1, align: 'left' },
      { id: 't', type: 'text', text: '<img src=x onerror=alert(1)>', align: 'left' },
    ]));
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img src=x/i);
    expect(html).not.toMatch(/<[^>]*\son\w+=/i);
    expect(html).not.toMatch(/<form/i);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta name="viewport"');
  });

  it('drops links that are not web or mail addresses', () => {
    const html = renderDesign(design([
      { id: 'b', type: 'button', label: 'Click', url: 'javascript:alert(1)', align: 'left' },
      { id: 'i', type: 'image', url: 'javascript:alert(2)', alt: 'Bad', link: 'data:text/html,hi', full: false },
      { id: 'h', type: 'header', brand: 'Shop', logo: 'javascript:x', align: 'left' },
      { id: 'c', type: 'columns', left: { heading: 'A', text: 'a', label: 'Go', url: 'vbscript:x' }, right: { heading: 'B', text: 'b', label: 'Mail', url: 'mailto:help@example.com' } },
    ]));
    expect(html).not.toMatch(/javascript:|vbscript:|data:text/i);
    expect(html).toContain('>Click</span>');
    expect(html).not.toContain('<img');
    expect(html).toContain('href="mailto:help@example.com"');
  });

  it('falls back to the default palette for bad colours', () => {
    const html = renderDesign(design([newBlock('button')], { accent: 'red;background:url(x)', background: '#12' }));
    expect(html).toContain(`background-color:${DEFAULT_SETTINGS.accent}`);
    expect(html).toContain(`background-color:${DEFAULT_SETTINGS.background}`);
    expect(html).not.toContain('url(x)');
  });

  it('renders every starter with its own content and its own structure', () => {
    const distinctive: Record<string, string[]> = {
      announcement: ['Introducing [Product Name]', 'See What Is New'],
      newsletter: ['[Your Company] Weekly', '[Third Story Title]', 'A line from a reader'],
      receipt: ['Total Paid', 'Delivery Details', 'Need Help?'],
      letter: ['Dear [Name],', 'Kind regards,', 'Georgia'],
    };
    for (const s of STARTERS) {
      const html = renderDesign(s.design);
      for (const text of distinctive[s.key]!) expect(html).toContain(text);
      expect(html).toContain('role="presentation"');
      expect(html).not.toMatch(/var\(--|display:\s*(flex|grid)/);
    }
    const orders = STARTERS.map((s) => s.design.blocks.map((b) => b.type).join(','));
    expect(new Set(orders).size).toBe(4);
    expect(starter('letter').design.blocks.some((b) => b.type === 'header')).toBe(false);
    // A preheader comes from the first text block.
    expect(renderDesign(starter('receipt').design)).toMatch(/display:none[^>]*>Thank you for your order/);
  });

  it('survives Sadi Mail’s own display cleaning', async () => {
    for (const s of STARTERS) {
      const { html } = await cleanHtml(renderDesign(s.design), { loadImages: true });
      expect(html).toContain('<table role="presentation"');
      expect(html).toContain(`background-color:${s.design.settings.surface}`);
      expect(html).toContain(`background-color:${s.design.settings.background}`);
    }
    const announcement = (await cleanHtml(renderDesign(starter('announcement').design), { loadImages: true })).html;
    expect(announcement).toContain('Introducing [Product Name]</h1>');
    expect(announcement).toMatch(/<a href="https:\/\/example\.com"[^>]*>See What Is New<\/a>/);
    expect(announcement).toContain(`background-color:${DEFAULT_SETTINGS.accent}`);
    const receipt = (await cleanHtml(renderDesign(starter('receipt').design), { loadImages: true })).html;
    expect(receipt).toContain('class="stack"');
    expect(receipt).toContain('Total Paid');
  });
});

describe('designToText', () => {
  it('reads like a plain email', () => {
    const text = designToText(starter('receipt').design);
    expect(text).toContain('Thank you for your order, [Customer Name].');
    expect(text).toContain('[Item One] × 1: [Amount]');
    expect(text).toContain('Total Paid: [Amount]');
    expect(text).toContain('Contact Us: mailto:help@example.com');
    expect(text).not.toMatch(/<[a-z]/i);
    const news = designToText(starter('newsletter').design);
    expect(news).toContain('Read The Story: https://example.com/first');
    expect(news).toContain('"A line from a reader');
    expect(designToText(starter('announcement').design)).toMatch(/^\[Your Company\]\n\nIntroducing \[Product Name\]\n=+/);
  });
});

describe('parseDesign', () => {
  it('refuses garbage and keeps only what it knows', () => {
    expect(parseDesign('not json')).toBeNull();
    expect(parseDesign('[]')).toBeNull();
    expect(parseDesign('{"blocks":"nope"}')).toBeNull();
    expect(parseDesign('{"version":2,"blocks":[]}')).toBeNull();
    const d = parseDesign(JSON.stringify({
      version: 1,
      settings: { accent: 'blue', radius: 900, font: 'comic' },
      blocks: [
        { id: 'a', type: 'heading', text: 'x'.repeat(5000), level: 7, align: 'middle' },
        { id: 'b', type: 'marquee', text: 'drop me' },
        { id: 'a', type: 'text', text: 'Same id' },
        'junk',
        ...Array.from({ length: 80 }, () => ({ type: 'divider' })),
      ],
    }))!;
    expect(d.settings).toMatchObject({ accent: DEFAULT_SETTINGS.accent, radius: 24, font: 'sans', width: 600 });
    expect(d.blocks).toHaveLength(60);
    expect(d.blocks[0]).toMatchObject({ type: 'heading', level: 2, align: 'left' });
    expect((d.blocks[0] as { text: string }).text.length).toBeLessThanOrEqual(300);
    expect(d.blocks[1]).toMatchObject({ type: 'text', text: 'Same id' });
    expect(new Set(d.blocks.map((b) => b.id)).size).toBe(60);
    expect(d.blocks.some((b) => (b.type as string) === 'marquee')).toBe(false);
  });
});

describe('designed drafts and templates', () => {
  it('saves a draft with its design, refuses a broken one, and sends it', async () => {
    const from = await fromAddress();
    const d = starter('announcement').design;
    const base = { fromAddressId: from.id, to: [{ name: '', email: 'reader@x.example' }], cc: [], bcc: [], subject: 'Designed', mode: 'new' };
    const made = await call<{ id: string; threadId: string }>('/api/drafts', post({ ...base, text: designToText(d), html: renderDesign(d), design: JSON.stringify(d) }));
    expect(made.status).toBe(200);
    const saved = (await call<DraftDetail>(`/api/drafts/${made.body.id}`)).body;
    expect(saved.design).toBeDefined();
    expect(parseDesign(saved.design!)!.blocks.map((b) => b.type)).toEqual(d.blocks.map((b) => b.type));

    const bad = await call<{ error: string }>('/api/drafts', post({ ...base, id: made.body.id, text: 'x', design: '{"blocks": 3}' }));
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe('bad_design');
    expect((await call<{ error: string }>('/api/drafts', post({ ...base, text: 'x', design: 'x'.repeat(210 * 1024) }))).body.error).toBe('bad_design');

    // Saving without a design turns it back into a written message.
    await call('/api/drafts', post({ ...base, id: made.body.id, text: 'Plain now' }));
    expect((await call<DraftDetail>(`/api/drafts/${made.body.id}`)).body.design).toBeUndefined();
    await call('/api/drafts', post({ ...base, id: made.body.id, text: designToText(d), html: renderDesign(d), design: JSON.stringify(d) }));

    const sent = (await call<SendResult>('/api/send', post({ fromAddressId: from.id, to: base.to, subject: 'Designed', draftId: made.body.id, html: renderDesign(d), text: designToText(d) }))).body;
    expect(sent.status).toBe('dry_run');
    const thread = (await call<ThreadDetail>(`/api/threads/${sent.threadId}`)).body;
    expect(thread.messages[0]!.html).toContain('Introducing [Product Name]');
    expect(thread.messages[0]!.text).toContain('See What Is New: https://example.com');
  });

  it('round-trips a designed template', async () => {
    const d = starter('newsletter').design;
    const made = await call<TemplateInfo>('/api/templates', post({ name: 'Design Test Weekly', subject: 'This week', body: '', design: JSON.stringify(d) }));
    expect(made.status).toBe(200);
    expect(made.body.body).toContain('[First Story Title]');
    const listed = (await call<{ data: TemplateInfo[] }>('/api/templates')).body.data.find((t) => t.id === made.body.id)!;
    expect(parseDesign(listed.design!)!.blocks).toHaveLength(d.blocks.length);
    await call('/api/templates', post({ id: made.body.id, name: 'Design Test Renamed', subject: 'This week', body: '', design: listed.design }));
    const renamed = (await call<{ data: TemplateInfo[] }>('/api/templates')).body.data.find((t) => t.id === made.body.id)!;
    expect(renamed).toMatchObject({ name: 'Design Test Renamed' });
    expect(renamed.design).toBeDefined();
    expect((await call<{ error: string }>('/api/templates', post({ name: 'Broken', design: '{' }))).body.error).toBe('bad_design');
    // Written templates are unchanged and carry no design.
    const plain = (await call<TemplateInfo>('/api/templates', post({ name: 'Design Test Plain', body: 'Hello' }))).body;
    expect(plain.design).toBeUndefined();
    await call(`/api/templates/${made.body.id}`, { method: 'DELETE' });
    await call(`/api/templates/${plain.id}`, { method: 'DELETE' });
  });
});
