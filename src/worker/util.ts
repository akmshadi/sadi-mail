import type { AuthResult, Person } from '../shared/types';

export interface Env {
  DB: D1Database;
  MAIL: R2Bucket;
  ASSETS?: Fetcher;
  /** Cloudflare Email Sending binding. Absent until a sending domain is onboarded. */
  EMAIL?: { send(message: unknown): Promise<{ messageId: string }> };
  /** Workers AI binding. Absent until the "ai" block in wrangler.jsonc is switched on. */
  AI?: { run(model: string, input: unknown): Promise<unknown> };
  /** Base64 of 32 random bytes; encrypts provider keys saved from the settings screen. A Worker secret. */
  MAIL_SECRET_KEY?: string;
  AI_DAILY_LIMIT?: string;
  SEND_MODE: string;
  AUTH_MODE: string;
  UNKNOWN_RECIPIENT: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  HOST_PUBLIC_KEYS: string;
  EMBED_ALLOWED_ORIGINS: string;
}

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** Time-ordered id: 9 chars of milliseconds then 12 random chars. Sorts by creation time. */
export function newId(now: number = Date.now()): string {
  let t = '';
  let n = now;
  for (let i = 0; i < 9; i++) {
    t = ALPHABET[n % 32] + t;
    n = Math.floor(n / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let r = '';
  for (const b of bytes) r += ALPHABET[b % 32];
  return t + r;
}

export function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}

/** Strip reply and forward prefixes so "Re: Re: Fwd: Hello" threads with "Hello". */
export function baseSubject(subject: string): string {
  let s = subject.trim();
  for (;;) {
    const next = s.replace(/^(re|fw|fwd|aw|sv|antw)\s*(\[\d+\])?\s*:\s*/i, '');
    if (next === s) return s;
    s = next;
  }
}

export function snippetOf(text: string, max = 180): string {
  const lines = text
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('>'))
    .join(' ');
  const flat = lines.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + '…' : flat;
}

/** Plain text from HTML, for messages that arrive with no text part. Used for search and snippets only. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/** Read spf, dkim and dmarc verdicts from the Authentication-Results header Cloudflare adds. */
export function parseAuthResults(header: string | null | undefined): { spf: AuthResult; dkim: AuthResult; dmarc: AuthResult } {
  const read = (key: string): AuthResult => {
    const match = header ? new RegExp(`\\b${key}=([a-z]+)`, 'i').exec(header) : null;
    if (!match) return 'none';
    const verdict = match[1]!.toLowerCase();
    if (verdict === 'pass') return 'pass';
    if (verdict === 'none' || verdict === 'neutral' || verdict === 'temperror') return 'none';
    return 'fail';
  };
  return { spf: read('spf'), dkim: read('dkim'), dmarc: read('dmarc') };
}

/** Message-IDs from a References or In-Reply-To header, without the angle brackets. */
export function parseIds(header: string | null | undefined): string[] {
  if (!header) return [];
  const found = header.match(/<[^<>\s]+>/g);
  return found ? found.map((id) => id.slice(1, -1)) : [];
}

export function toPeople(list: { name?: string; address?: string }[] | undefined): Person[] {
  if (!list) return [];
  return list.filter((p) => p.address).map((p) => ({ name: p.name ?? '', email: normaliseEmail(p.address!) }));
}

/** Turn free text into an FTS5 query: every word must match, the last one as a prefix. */
export function ftsQuery(input: string): string | null {
  const words = input.match(/[\p{L}\p{N}@._-]+/gu);
  if (!words || words.length === 0) return null;
  return words.map((w, i) => `"${w.replace(/"/g, '')}"${i === words.length - 1 ? '*' : ''}`).join(' ');
}

export const BODY_CAP = 256 * 1024;
