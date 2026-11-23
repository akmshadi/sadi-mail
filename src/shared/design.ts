// The Email Design Builder's document model and renderer. Pure: no DOM, no Node, so the
// compose page, the Worker and the tests all use the same code.
//
// The renderer writes the kind of HTML that survives real mail clients: nested presentation
// tables, every style inline, font stacks instead of web fonts, a bulletproof button, and one
// optional media query that stacks two columns on a narrow screen.

export type Align = 'left' | 'center' | 'right';
export type FontKey = 'sans' | 'serif' | 'mono';
export type Layout = 'center' | 'left';
/** How the header band is coloured: the text colour, the accent colour, or the card itself with a line under it. */
export type HeaderTone = 'dark' | 'accent' | 'light';

export interface DesignSettings {
  width: 600;
  background: string;
  surface: string;
  text: string;
  muted: string;
  accent: string;
  accentText: string;
  font: FontKey;
  radius: number;
  /** Centred: a card in the middle of the window on a coloured ground. Left: flush left on white, like a letter someone typed. */
  layout: Layout;
}

export interface HeaderBlock { id: string; type: 'header'; brand: string; logo: string; align: Align; tone?: HeaderTone; tagline?: string }
export interface HeadingBlock { id: string; type: 'heading'; text: string; level: 1 | 2; align: Align }
export interface TextBlock { id: string; type: 'text'; text: string; align: Align }
export interface ButtonBlock { id: string; type: 'button'; label: string; url: string; align: Align }
export interface ImageBlock { id: string; type: 'image'; url: string; alt: string; link: string; full: boolean }
export interface DividerBlock { id: string; type: 'divider' }
export interface SpacerBlock { id: string; type: 'spacer'; height: number }
export interface Column { heading: string; text: string; label: string; url: string }
export interface ColumnsBlock { id: string; type: 'columns'; left: Column; right: Column }
export interface ItemRow { label: string; amount: string }
export interface ItemsBlock { id: string; type: 'items'; rows: ItemRow[]; total: ItemRow | null }
export interface QuoteBlock { id: string; type: 'quote'; text: string; cite: string }
export interface FooterBlock { id: string; type: 'footer'; text: string; address: string }

export type Block =
  | HeaderBlock | HeadingBlock | TextBlock | ButtonBlock | ImageBlock | DividerBlock
  | SpacerBlock | ColumnsBlock | ItemsBlock | QuoteBlock | FooterBlock;
export type BlockType = Block['type'];

export interface EmailDesign {
  version: 1;
  settings: DesignSettings;
  blocks: Block[];
}

export const MAX_BLOCKS = 60;
export const MAX_ROWS = 40;

/** Names shown in the builder, in the order the Add Block menu lists them. */
export const BLOCK_NAMES: Record<BlockType, string> = {
  header: 'Header',
  heading: 'Heading',
  text: 'Text',
  button: 'Button',
  image: 'Image',
  divider: 'Divider',
  spacer: 'Spacer',
  columns: 'Two Columns',
  items: 'Items And Total',
  quote: 'Quote',
  footer: 'Footer',
};
export const BLOCK_TYPES = Object.keys(BLOCK_NAMES) as BlockType[];

export const DEFAULT_SETTINGS: DesignSettings = {
  width: 600,
  background: '#F3F4F6',
  surface: '#FFFFFF',
  text: '#111827',
  muted: '#6B7280',
  accent: '#4F46E5',
  accentText: '#FFFFFF',
  font: 'sans',
  radius: 8,  layout: 'center',
};

const FONTS: Record<FontKey, string> = {
  sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  serif: "Georgia, 'Times New Roman', Times, serif",
  mono: "'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', 'Courier New', monospace",
};

// ---------- small helpers ----------

let seq = 0;
/** A short id for a block. Only needs to be unique inside one design. */
export function blockId(): string {
  seq = (seq + 1) % 1_000_000;
  return `b${Date.now().toString(36)}${seq.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** A link Sadi Mail will put in an email: web and mail addresses only. Anything else means no link. */
export function safeUrl(url: string): string | null {
  const u = url.trim();
  if (!u || /[\s<>"'`\u0000-\u001f]/.test(u)) return null;
  return /^(https?:\/\/[^/]|mailto:[^/])/i.test(u) ? u : null;
}
/** An image address: web only. */
export function safeImage(url: string): string | null {
  const u = safeUrl(url);
  return u && /^https?:\/\//i.test(u) ? u : null;
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
export function validColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && HEX.test(value.trim()) ? value.trim() : fallback;
}
/** #abc → #aabbcc, upper case. Returns null for anything that is not a colour. */
export function hex6(value: string): string | null {
  const v = value.trim();
  if (!HEX.test(v)) return null;
  const h = v.slice(1);
  return `#${(h.length === 3 ? h.split('').map((c) => c + c).join('') : h).toUpperCase()}`;
}
const rgb = (c: string): [number, number, number] => {
  const h = (hex6(c) ?? '#000000').slice(1);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};
/** Blend two colours: t = 0 gives a, t = 1 gives b. */
export function mix(a: string, b: string, t: number): string {
  const x = rgb(a);
  const y = rgb(b);
  return `#${x.map((v, i) => Math.round(v + ((y[i] ?? 0) - v) * t).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}
/** Relative luminance, 0 (black) to 1 (white). */
export function luminance(c: string): number {
  const [r, g, b] = rgb(c).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** Text colour that reads on a given background. */
export const readableOn = (bg: string): string => (luminance(bg) > 0.45 ? '#111827' : '#FFFFFF');

const align = (a: unknown): Align => (a === 'center' || a === 'right' ? a : 'left');
const clamp = (n: unknown, lo: number, hi: number, fallback: number): number => {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : fallback;
  return Math.min(hi, Math.max(lo, v));
};

function settingsOf(s: Partial<DesignSettings> | undefined): DesignSettings {
  const d = DEFAULT_SETTINGS;
  return {
    width: 600,
    background: validColor(s?.background, d.background),
    surface: validColor(s?.surface, d.surface),
    text: validColor(s?.text, d.text),
    muted: validColor(s?.muted, d.muted),
    accent: validColor(s?.accent, d.accent),
    accentText: validColor(s?.accentText, d.accentText),
    font: s?.font === 'serif' || s?.font === 'mono' ? s.font : 'sans',
    radius: clamp(s?.radius, 0, 24, d.radius),
    layout: s?.layout === 'left' ? 'left' : 'center',
  };
}

// ---------- blocks ----------

const emptyColumn = (): Column => ({ heading: '', text: '', label: '', url: '' });

/** A new block with sensible starting content. */
export function newBlock(type: BlockType): Block {
  const id = blockId();
  switch (type) {
    case 'header': return { id, type, brand: '[Your Company]', logo: '', align: 'center' };
    case 'heading': return { id, type, text: 'A clear, short heading', level: 2, align: 'left' };
    case 'text': return { id, type, text: 'Write a paragraph here. Leave a blank line to start a new paragraph.', align: 'left' };
    case 'button': return { id, type, label: 'Learn More', url: 'https://example.com', align: 'left' };
    case 'image': return { id, type, url: '', alt: '', link: '', full: false };
    case 'divider': return { id, type };
    case 'spacer': return { id, type, height: 24 };
    case 'columns': return {
      id, type,
      left: { heading: 'Left Column', text: 'A short note for this side.', label: '', url: '' },
      right: { heading: 'Right Column', text: 'A short note for this side.', label: '', url: '' },
    };
    case 'items': return { id, type, rows: [{ label: '[Item]', amount: '[Amount]' }], total: { label: 'Total', amount: '[Amount]' } };
    case 'quote': return { id, type, text: 'A short quote that is worth repeating.', cite: '[Name], [Role]' };
    case 'footer': return { id, type, text: 'You are receiving this email from [Your Company].', address: '' };
  }
}

/** The same block with a fresh id, for Duplicate. */
export function copyBlock(b: Block): Block {
  return { ...(JSON.parse(JSON.stringify(b)) as Block), id: blockId() };
}

/** A working copy of a design, every block with a fresh id. */
export function instantiate(design: EmailDesign): EmailDesign {
  return { version: 1, settings: { ...design.settings }, blocks: design.blocks.map(copyBlock) };
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const SHORT = 300;
const LONG = 5000;
const URL_MAX = 2048;

function columnOf(v: unknown): Column {
  const c = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return { heading: str(c.heading, SHORT), text: str(c.text, LONG), label: str(c.label, 120), url: str(c.url, URL_MAX) };
}
function rowOf(v: unknown): ItemRow {
  const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return { label: str(r.label, SHORT), amount: str(r.amount, 60) };
}

/** Rebuild one block from untrusted data. Unknown types give null. */
function blockOf(v: unknown, id: string): Block | null {
  if (!v || typeof v !== 'object') return null;
  const b = v as Record<string, unknown>;
  switch (b.type) {
    case 'header': return { id, type: 'header', brand: str(b.brand, SHORT), logo: str(b.logo, URL_MAX), align: align(b.align), tone: b.tone === 'accent' || b.tone === 'light' ? b.tone : 'dark', tagline: str(b.tagline, SHORT) };
    case 'heading': return { id, type: 'heading', text: str(b.text, SHORT), level: b.level === 1 ? 1 : 2, align: align(b.align) };
    case 'text': return { id, type: 'text', text: str(b.text, LONG), align: align(b.align) };
    case 'button': return { id, type: 'button', label: str(b.label, 120), url: str(b.url, URL_MAX), align: align(b.align) };
    case 'image': return { id, type: 'image', url: str(b.url, URL_MAX), alt: str(b.alt, SHORT), link: str(b.link, URL_MAX), full: b.full === true };
    case 'divider': return { id, type: 'divider' };
    case 'spacer': return { id, type: 'spacer', height: clamp(b.height, 4, 96, 24) };
    case 'columns': return { id, type: 'columns', left: columnOf(b.left), right: columnOf(b.right) };
    case 'items': return {
      id, type: 'items',
      rows: (Array.isArray(b.rows) ? b.rows : []).slice(0, MAX_ROWS).map(rowOf),
      total: b.total && typeof b.total === 'object' ? rowOf(b.total) : null,
    };
    case 'quote': return { id, type: 'quote', text: str(b.text, LONG), cite: str(b.cite, SHORT) };
    case 'footer': return { id, type: 'footer', text: str(b.text, LONG), address: str(b.address, SHORT) };
    default: return null;
  }
}

/** Read a stored or submitted design. Returns null when it is not a design at all; drops what it does not know. */
export function parseDesign(json: string): EmailDesign | null {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (d.version !== undefined && d.version !== 1) return null;
  if (!Array.isArray(d.blocks)) return null;
  const seen = new Set<string>();
  const blocks: Block[] = [];
  for (const raw of d.blocks) {
    if (blocks.length >= MAX_BLOCKS) break;
    const given = raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : undefined;
    let id = typeof given === 'string' && /^[\w-]{1,40}$/.test(given) ? given : blockId();
    if (seen.has(id)) id = blockId();
    const block = blockOf(raw, id);
    if (!block) continue;
    seen.add(id);
    blocks.push(block);
  }
  const settings = d.settings && typeof d.settings === 'object' ? (d.settings as Partial<DesignSettings>) : undefined;
  return { version: 1, settings: settingsOf(settings), blocks };
}

// ---------- rendering ----------

interface Ctx {
  s: DesignSettings;
  font: string;
  line: string;
  ink: string;
  preview: boolean;
}

const PAD_X = 40;
const paragraphs = (text: string): string[] => text.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/).map((p) => p.trim()).filter(Boolean);
const withBreaks = (p: string): string => esc(p).replace(/\n/g, '<br>');
const row = (inner: string, style: string, attrs = ''): string => `<tr><td class="pad"${attrs} style="${style}">${inner}</td></tr>`;

function buttonHtml(c: Ctx, label: string, url: string, alignTo: Align, size: 'md' | 'sm' = 'md'): string {
  const href = safeUrl(url);
  const { s } = c;
  const pad = size === 'md' ? '12px 24px' : '9px 18px';
  const fs = size === 'md' ? 16 : 14;
  const look = `display:inline-block;padding:${pad};font-family:${c.font};font-size:${fs}px;font-weight:600;line-height:1.2;color:${s.accentText};text-decoration:none;background-color:${s.accent};border-radius:${s.radius}px;mso-padding-alt:0;`;
  const inner = href
    ? `<a href="${esc(href)}" target="_blank" style="${look}">${esc(label)}</a>`
    : `<span style="${look}">${esc(label)}</span>`;
  const place = alignTo === 'center' ? 'margin:0 auto;' : alignTo === 'right' ? 'margin:0 0 0 auto;' : '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;${place}"><tr><td align="center" bgcolor="${s.accent}" style="background-color:${s.accent};border-radius:${s.radius}px;">${inner}</td></tr></table>`;
}

const imgMargin = (a: Align): string => (a === 'center' ? 'margin:0 auto;' : a === 'right' ? 'margin:0 0 0 auto;' : '');

function blockHtml(b: Block, c: Ctx): string {
  const { s, font } = c;
  const text = (size: number, color: string, extra = '') => `margin:0;font-family:${font};font-size:${size}px;line-height:1.6;color:${color};${extra}`;
  switch (b.type) {
    case 'header': {
      const logo = safeImage(b.logo);
      const bg = b.tone === 'accent' ? s.accent : b.tone === 'light' ? s.surface : c.ink;
      const fg = b.tone === 'light' ? s.text : readableOn(bg);
      const sub = b.tagline?.trim() ? `<p style="margin:${logo ? 10 : 4}px 0 0;font-family:${font};font-size:13px;line-height:1.4;color:${fg};opacity:0.8;">${esc(b.tagline.trim())}</p>` : '';
      const inner = logo
        ? `<img src="${esc(logo)}" width="140" alt="${esc(b.brand)}" style="display:block;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;${imgMargin(b.align)}">`
        : `<p style="margin:0;font-family:${font};font-size:20px;line-height:1.3;font-weight:700;letter-spacing:-0.01em;color:${fg};">${esc(b.brand)}</p>`;
      return row(inner + sub, `padding:22px ${PAD_X}px;background-color:${bg};text-align:${b.align};${b.tone === 'light' ? `border-bottom:1px solid ${c.line};` : ''}`, ` align="${b.align}" bgcolor="${bg}"`);
    }
    case 'heading': {
      const tag = b.level === 1 ? 'h1' : 'h2';
      const size = b.level === 1 ? 30 : 21;
      return row(
        `<${tag} style="margin:0;font-family:${font};font-size:${size}px;line-height:1.25;font-weight:700;letter-spacing:-0.01em;color:${s.text};text-align:${b.align};">${esc(b.text)}</${tag}>`,
        `padding:${b.level === 1 ? 28 : 20}px ${PAD_X}px 8px;`,
        ` align="${b.align}"`,
      );
    }
    case 'text': {
      const ps = paragraphs(b.text);
      if (!ps.length) return '';
      return row(
        ps.map((p, i) => `<p style="${text(16, s.text, `text-align:${b.align};${i < ps.length - 1 ? 'margin-bottom:16px;' : ''}`)}">${withBreaks(p)}</p>`).join(''),
        `padding:8px ${PAD_X}px;`,
        ` align="${b.align}"`,
      );
    }
    case 'button':
      return row(buttonHtml(c, b.label || 'Button', b.url, b.align), `padding:16px ${PAD_X}px;`, ` align="${b.align}"`);
    case 'image': {
      const src = safeImage(b.url);
      const width = b.full ? 600 : 600 - PAD_X * 2;
      const pad = b.full ? 'padding:8px 0;' : `padding:12px ${PAD_X}px;`;
      if (!src) {
        if (!c.preview) return '';
        return row(`<div style="border:1px dashed ${c.line};border-radius:${s.radius}px;padding:36px 16px;text-align:center;font-family:${font};font-size:14px;color:${s.muted};">Image: add an image address</div>`, pad);
      }
      const img = `<img src="${esc(src)}" width="${width}" alt="${esc(b.alt)}" style="display:block;width:100%;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;${b.full ? '' : `border-radius:${s.radius}px;`}">`;
      const link = safeUrl(b.link);
      return row(link ? `<a href="${esc(link)}" target="_blank" style="display:block;text-decoration:none;">${img}</a>` : img, pad, b.full ? ' class="full"' : '');
    }
    case 'divider':
      return row(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid ${c.line};font-size:0;line-height:0;height:1px;">&nbsp;</td></tr></table>`,
        `padding:16px ${PAD_X}px;`,
      );
    case 'spacer':
      return `<tr><td height="${b.height}" style="height:${b.height}px;font-size:0;line-height:0;">&nbsp;</td></tr>`;
    case 'columns': {
      const col = (k: Column) => {
        const ps = paragraphs(k.text);
        return [
          k.heading ? `<h3 style="margin:0 0 6px;font-family:${font};font-size:16px;line-height:1.35;font-weight:700;color:${s.text};">${esc(k.heading)}</h3>` : '',
          ps.map((p) => `<p style="${text(15, s.text, 'margin-bottom:10px;')}">${withBreaks(p)}</p>`).join(''),
          k.label ? `<div style="padding-top:4px;">${buttonHtml(c, k.label, k.url, 'left', 'sm')}</div>` : '',
        ].join('');
      };
      const cell = (k: Column, side: 'l' | 'r') =>
        `<td class="stack" width="50%" valign="top" style="width:50%;vertical-align:top;padding:0 ${side === 'l' ? 12 : 0}px 12px ${side === 'r' ? 12 : 0}px;">${col(k)}</td>`;
      return row(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${cell(b.left, 'l')}${cell(b.right, 'r')}</tr></table>`,
        `padding:12px ${PAD_X}px 4px;`,
      );
    }
    case 'items': {
      const cellStyle = (right: boolean, strong: boolean, top: string) =>
        `padding:10px 0;${top}font-family:${font};font-size:15px;line-height:1.4;color:${s.text};${strong ? 'font-weight:700;' : ''}${right ? 'text-align:right;white-space:nowrap;padding-left:16px;' : ''}`;
      const rows = b.rows.map((r) =>
        `<tr><td style="${cellStyle(false, false, `border-bottom:1px solid ${c.line};`)}">${esc(r.label)}</td><td align="right" style="${cellStyle(true, false, `border-bottom:1px solid ${c.line};`)}">${esc(r.amount)}</td></tr>`,
      ).join('');
      const total = b.total
        ? `<tr><td style="${cellStyle(false, true, `border-top:2px solid ${s.text};`)}">${esc(b.total.label)}</td><td align="right" style="${cellStyle(true, true, `border-top:2px solid ${s.text};`)}">${esc(b.total.amount)}</td></tr>`
        : '';
      return row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${rows}${total}</table>`, `padding:12px ${PAD_X}px;`);
    }
    case 'quote':
      return row(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-left:3px solid ${s.accent};padding:4px 0 4px 20px;">`
          + `<p style="${text(18, s.text, 'font-style:italic;line-height:1.5;')}">${withBreaks(b.text)}</p>`
          + (b.cite ? `<p style="${text(14, s.muted, 'margin-top:8px;')}">${esc(b.cite)}</p>` : '')
          + '</td></tr></table>',
        `padding:16px ${PAD_X}px;`,
      );
    case 'footer': {
      const ps = paragraphs(b.text);
      return row(
        ps.map((p) => `<p style="${text(13, s.muted, 'line-height:1.55;margin-bottom:6px;')}">${withBreaks(p)}</p>`).join('')
          + (b.address ? `<p style="${text(12, s.muted, 'line-height:1.5;')}">${esc(b.address)}</p>` : ''),
        `padding:24px ${PAD_X}px 28px;border-top:1px solid ${c.line};text-align:center;`,
        ' align="center"',
      );
    }
  }
}

/** The first words of the first text block, for the inbox preview line. */
function preheaderOf(design: EmailDesign): string {
  for (const b of design.blocks) {
    if (b.type === 'text' && b.text.trim()) return b.text.replace(/\s+/g, ' ').trim().slice(0, 140);
  }
  return '';
}

/**
 * A complete, email-safe HTML document for a design.
 * `preview` shows placeholders for blocks that would otherwise render nothing (an image with no address yet).
 */
export function renderDesign(design: EmailDesign, options: { preview?: boolean } = {}): string {
  const s = settingsOf(design.settings);
  const c: Ctx = { s, font: FONTS[s.font], line: mix(s.surface, s.text, 0.14), ink: s.text, preview: options.preview === true };
  const blocks = design.blocks.slice(0, MAX_BLOCKS);
  const first = blocks[0]?.type;
  const last = blocks[blocks.length - 1]?.type;
  const body = blocks.map((b) => blockHtml(b, c)).join('');
  const edge = (h: number) => `<tr><td height="${h}" style="height:${h}px;font-size:0;line-height:0;">&nbsp;</td></tr>`;
  const pre = preheaderOf(design);
  // Left layout: no coloured ground and no card, so it reads like ordinary mail that happens to be designed.
  const left = s.layout === 'left';
  if (left) s.background = s.surface;
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="x-apple-disable-message-reformatting">',
    '<style>@media only screen and (max-width:620px){.stack{display:block!important;width:100%!important;max-width:100%!important;padding-left:0!important;padding-right:0!important}.pad{padding-left:24px!important;padding-right:24px!important}.full{padding-left:0!important;padding-right:0!important}.outer{padding:0!important}}</style>',
    `</head><body style="margin:0;padding:0;width:100%;background-color:${s.background};-webkit-text-size-adjust:100%;">`,
    pre ? `<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${s.background};">${esc(pre)}${'&#8204;&nbsp;'.repeat(24)}</div>` : '',
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${s.background}" style="width:100%;background-color:${s.background};">`,
    left ? '<tr><td class="outer" align="left" style="padding:0;">' : '<tr><td class="outer" align="center" style="padding:24px 12px;">',
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="${s.surface}" align="${left ? 'left' : 'center'}" style="width:600px;max-width:100%;background-color:${s.surface};border-radius:${left ? 0 : s.radius}px;border-collapse:separate;overflow:hidden;">`,
    first && first !== 'header' ? edge(16) : '',
    body,
    last && last !== 'footer' ? edge(24) : '',
    '</table>',
    '</td></tr></table>',
    '</body></html>',
  ].join('\n');
}

// ---------- plain text ----------

/** A readable plain-text version for the text part of the email. */
export function designToText(design: EmailDesign): string {
  const out: string[] = [];
  const tidy = (t: string) => paragraphs(t).join('\n\n');
  const link = (label: string, url: string) => {
    const href = safeUrl(url);
    return label.trim() ? (href ? `${label.trim()}: ${href}` : label.trim()) : href ?? '';
  };
  for (const b of design.blocks) {
    switch (b.type) {
      case 'header': out.push(b.brand.trim()); break;
      case 'heading': {
        const t = b.text.trim();
        if (t) out.push(b.level === 1 ? `${t}\n${'='.repeat(Math.min(t.length, 60))}` : t);
        break;
      }
      case 'text': out.push(tidy(b.text)); break;
      case 'button': out.push(link(b.label, b.url)); break;
      case 'image': {
        const alt = b.alt.trim();
        const href = safeUrl(b.link);
        if (alt || href) out.push(href ? `${alt || 'Image'}: ${href}` : `[${alt}]`);
        break;
      }
      case 'divider': out.push('----------'); break;
      case 'spacer': break;
      case 'columns':
        for (const k of [b.left, b.right]) out.push([k.heading.trim(), tidy(k.text), link(k.label, k.url)].filter(Boolean).join('\n'));
        break;
      case 'items': {
        const lines = b.rows.filter((r) => r.label.trim() || r.amount.trim()).map((r) => `${r.label.trim()}: ${r.amount.trim()}`);
        if (b.total) lines.push('', `${b.total.label.trim() || 'Total'}: ${b.total.amount.trim()}`);
        out.push(lines.join('\n'));
        break;
      }
      case 'quote': out.push([b.text.trim() ? `"${b.text.trim()}"` : '', b.cite.trim() ? `— ${b.cite.trim()}` : ''].filter(Boolean).join('\n')); break;
      case 'footer': out.push(['--', tidy(b.text), b.address.trim()].filter(Boolean).join('\n')); break;
    }
  }
  return out.filter((p) => p.trim()).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- starting designs ----------

export interface Starter {
  key: 'announcement' | 'newsletter' | 'receipt' | 'letter';
  name: string;
  description: string;
  design: EmailDesign;
}

let starterSeq = 0;
const sid = () => `s${++starterSeq}`;

export const STARTERS: Starter[] = [
  {
    key: 'announcement',
    name: 'Announcement',
    description: 'One message and one button.',
    design: {
      version: 1,
      settings: { ...DEFAULT_SETTINGS },
      blocks: [
        { id: sid(), type: 'header', brand: '[Your Company]', logo: '', align: 'center' },
        { id: sid(), type: 'heading', text: 'Introducing [Product Name]', level: 1, align: 'center' },
        { id: sid(), type: 'text', text: 'Say what is new, who it is for and why it matters, in two or three sentences. Keep the rest for the page the button opens.', align: 'center' },
        { id: sid(), type: 'button', label: 'See What Is New', url: 'https://example.com', align: 'center' },
        { id: sid(), type: 'footer', text: 'You are receiving this email because you signed up with [Your Company].', address: '[Street Address], [City], [Country]' },
      ],
    },
  },
  {
    key: 'newsletter',
    name: 'Newsletter',
    description: 'A masthead and three stories.',
    design: {
      version: 1,
      settings: { ...DEFAULT_SETTINGS, background: '#E9ECF2', radius: 4 },
      blocks: [
        { id: sid(), type: 'header', brand: '[Your Company] Weekly', logo: '', align: 'left' },
        { id: sid(), type: 'text', text: 'Hello [First Name],\n\nHere is what happened this week, in three short stories.', align: 'left' },
        { id: sid(), type: 'heading', text: '[First Story Title]', level: 2, align: 'left' },
        { id: sid(), type: 'text', text: 'Two or three sentences that tell the story and make the reader want to know more.', align: 'left' },
        { id: sid(), type: 'button', label: 'Read The Story', url: 'https://example.com/first', align: 'left' },
        { id: sid(), type: 'divider' },
        { id: sid(), type: 'heading', text: '[Second Story Title]', level: 2, align: 'left' },
        { id: sid(), type: 'text', text: 'Two or three sentences that tell the story and make the reader want to know more.', align: 'left' },
        { id: sid(), type: 'button', label: 'Read The Story', url: 'https://example.com/second', align: 'left' },
        { id: sid(), type: 'divider' },
        { id: sid(), type: 'heading', text: '[Third Story Title]', level: 2, align: 'left' },
        { id: sid(), type: 'text', text: 'Two or three sentences that tell the story and make the reader want to know more.', align: 'left' },
        { id: sid(), type: 'button', label: 'Read The Story', url: 'https://example.com/third', align: 'left' },
        { id: sid(), type: 'quote', text: 'A line from a reader, a customer or the team that is worth sharing.', cite: '[Name], [Role]' },
        { id: sid(), type: 'footer', text: 'You are receiving this newsletter because you subscribed at [Your Company].\n\nTo stop receiving it, reply with “unsubscribe”.', address: '[Street Address], [City], [Country]' },
      ],
    },
  },
  {
    key: 'receipt',
    name: 'Receipt',
    description: 'Items, a total and delivery details.',
    design: {
      version: 1,
      settings: { ...DEFAULT_SETTINGS, accent: '#111827', radius: 6 },
      blocks: [
        { id: sid(), type: 'header', brand: '[Your Company]', logo: '', align: 'left' },
        { id: sid(), type: 'text', text: 'Thank you for your order, [Customer Name]. This is your receipt for order [Order Number], placed on [Date].', align: 'left' },
        {
          id: sid(), type: 'items',
          rows: [
            { label: '[Item One] × 1', amount: '[Amount]' },
            { label: '[Item Two] × 2', amount: '[Amount]' },
            { label: 'Delivery', amount: '[Amount]' },
          ],
          total: { label: 'Total Paid', amount: '[Amount]' },
        },
        {
          id: sid(), type: 'columns',
          left: { heading: 'Delivery Details', text: '[Customer Name]\n[Street Address]\n[City], [Postcode]\n\nExpected on [Date].', label: '', url: '' },
          right: { heading: 'Need Help?', text: 'Reply to this email or contact us and quote your order number.', label: 'Contact Us', url: 'mailto:help@example.com' },
        },
        { id: sid(), type: 'footer', text: '[Your Company] · Keep this email for your records.', address: '[Street Address], [City], [Country]' },
      ],
    },
  },
  {
    key: 'letter',
    name: 'Letter',
    description: 'A plain, personal letter.',
    design: {
      version: 1,
      settings: { ...DEFAULT_SETTINGS, background: '#F5F5F4', text: '#1C1917', muted: '#78716C', accent: '#1C1917', font: 'serif', radius: 0 },
      blocks: [
        { id: sid(), type: 'text', text: '[Your Company] · [Street Address] · [City]', align: 'left' },
        { id: sid(), type: 'divider' },
        { id: sid(), type: 'text', text: 'Dear [Name],', align: 'left' },
        { id: sid(), type: 'text', text: 'Write the first paragraph of your letter here. A letter reads best when each paragraph makes one point.\n\nUse the second paragraph for the detail, and the third for what happens next.\n\nThank you for your time.', align: 'left' },
        { id: sid(), type: 'text', text: 'Kind regards,\n\n[Your Name]\n[Your Title], [Your Company]', align: 'left' },
        { id: sid(), type: 'footer', text: '[Your Company]', address: '' },
      ],
    },
  },
];

export const starter = (key: Starter['key']): Starter => STARTERS.find((s) => s.key === key) ?? STARTERS[0]!;

const shape = (d: EmailDesign): string => JSON.stringify({ s: settingsOf(d.settings), b: d.blocks.map(({ id: _id, ...rest }) => rest) });

/** True when two designs say the same thing, ignoring block ids. */
export const sameDesign = (a: EmailDesign, b: EmailDesign): boolean => shape(a) === shape(b);

/** True when a design is one of the starters, unedited: replacing it loses nothing. */
export const isStarter = (d: EmailDesign): boolean => STARTERS.some((s) => sameDesign(s.design, d));


// ---------- company letterhead ----------

/** A mailbox's company header and footer, saved once in Settings and used by designed messages sent from it. */
export interface Letterhead {
  on: boolean;
  brand: string;
  tagline: string;
  logo: string;
  align: Align;
  tone: HeaderTone;
  footer: string;
  address: string;
  accent: string;
  layout: Layout;
}

export const EMPTY_LETTERHEAD: Letterhead = { on: false, brand: '', tagline: '', logo: '', align: 'left', tone: 'light', footer: '', address: '', accent: DEFAULT_SETTINGS.accent, layout: 'center' };

export function parseLetterhead(input: unknown): Letterhead {
  const v = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const one = (x: unknown, max: number) => (typeof x === 'string' ? x.replace(/[\r\n]+/g, ' ').trim().slice(0, max) : '');
  return {
    on: v.on === true,
    brand: one(v.brand, 80), tagline: one(v.tagline, 120), logo: safeImage(one(v.logo, 2048)) ?? '',
    align: v.align === 'center' || v.align === 'right' ? v.align : 'left',
    tone: v.tone === 'dark' || v.tone === 'accent' ? v.tone : 'light',
    footer: typeof v.footer === 'string' ? v.footer.replace(/\r/g, '').trim().slice(0, 600) : '', address: one(v.address, 200),
    accent: validColor(v.accent, DEFAULT_SETTINGS.accent), layout: v.layout === 'left' ? 'left' : 'center',
  };
}

export const letterheadReady = (l: Letterhead) => l.on && !!(l.brand || l.logo);

/** Put the company header first and the company footer last, replacing any the design already has. */
export function withLetterhead(design: EmailDesign, l: Letterhead): EmailDesign {
  const middle = design.blocks.filter((b, i) => !(i === 0 && b.type === 'header') && !(i === design.blocks.length - 1 && b.type === 'footer'));
  const header: HeaderBlock = { id: blockId(), type: 'header', brand: l.brand, logo: l.logo, align: l.align, tone: l.tone, tagline: l.tagline };
  const footer: FooterBlock | null = l.footer || l.address ? { id: blockId(), type: 'footer', text: l.footer, address: l.address } : null;
  return { ...design, settings: { ...design.settings, accent: l.accent, layout: l.layout }, blocks: [header, ...middle, ...(footer ? [footer] : [])] };
}

const BODY_MARK = '@@sadi-mail-letter-body@@';

/** An ordinary rich-text message set inside the company header and footer. The body HTML is the sender's own. */
export function renderLetter(bodyHtml: string, l: Letterhead): string {
  const design = withLetterhead({ version: 1, settings: { ...DEFAULT_SETTINGS }, blocks: [{ id: 'body', type: 'text', text: BODY_MARK, align: 'left' }] }, l);
  const html = renderDesign(design);
  // The mark also lands in the hidden preview line at the top; the last one is the body.
  const at = html.lastIndexOf(BODY_MARK);
  if (at < 0) return html;
  const open = html.lastIndexOf('<p', at);
  const close = html.indexOf('</p>', at) + 4;
  const s = design.settings;
  return `${html.slice(0, open).split(BODY_MARK).join('')}<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:${s.text};">${bodyHtml}</div>${html.slice(close)}`;
}
