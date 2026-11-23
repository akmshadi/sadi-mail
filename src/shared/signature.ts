// A signature is the block that closes every message sent from one address: who you are and how
// to reach you. It is added for you; a template, by contrast, is a whole message you choose to insert.

export interface SignatureFields {
  closing: string; // "Best regards,"
  name: string;
  title: string;
  company: string;
  phone: string;
  website: string;
  logoUrl: string;
  style: 'simple' | 'divider' | 'compact';
}

export const EMPTY_SIGNATURE: SignatureFields = { closing: 'Best regards,', name: '', title: '', company: '', phone: '', website: '', logoUrl: '', style: 'divider' };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\r\n]+/g, ' ').trim().slice(0, max) : '');

/** A web address people may have typed without "https://". Returns '' when it is not a usable link. */
function webLink(value: string): string {
  if (!value) return '';
  const url = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return /^https?:\/\/[^\s"'<>]+\.[^\s"'<>]+$/i.test(url) ? url : '';
}

export function parseSignature(input: unknown): SignatureFields {
  const v = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const style = v.style === 'simple' || v.style === 'compact' ? v.style : 'divider';
  return {
    closing: clean(v.closing, 60), name: clean(v.name, 80), title: clean(v.title, 80), company: clean(v.company, 80),
    phone: clean(v.phone, 40), website: clean(v.website, 120), logoUrl: clean(v.logoUrl, 300), style,
  };
}

export const signatureIsEmpty = (f: SignatureFields) => !f.name && !f.title && !f.company && !f.phone && !f.website;

/** The signature as plain text, for plain-text mail and quick replies. */
export function signatureText(f: SignatureFields): string {
  if (signatureIsEmpty(f)) return '';
  const role = [f.title, f.company].filter(Boolean).join(f.style === 'compact' ? ' · ' : ', ');
  const reach = [f.phone, f.website.replace(/^https?:\/\//i, '')].filter(Boolean);
  if (f.style === 'compact') return [f.closing, [f.name, role].filter(Boolean).join(' · '), reach.join(' · ')].filter(Boolean).join('\n');
  return [f.closing, f.name, role, ...reach].filter(Boolean).join('\n');
}

/** The signature as email-safe HTML: a small table, inline styles only. Everything typed is escaped. */
export function signatureHtml(f: SignatureFields): string {
  if (signatureIsEmpty(f)) return '';
  const link = webLink(f.website);
  const logo = /^https:\/\/[^\s"'<>]+$/i.test(f.logoUrl) ? f.logoUrl : '';
  const muted = 'color:#64748b;font-size:13px;line-height:1.5';
  const role = [f.title, f.company].filter(Boolean).map(esc).join(f.style === 'compact' ? ' · ' : ', ');
  const site = link ? `<a href="${esc(link)}" style="color:#4f46e5;text-decoration:none">${esc(f.website.replace(/^https?:\/\//i, ''))}</a>` : esc(f.website);
  const reach = [f.phone ? esc(f.phone) : '', f.website ? site : ''].filter(Boolean);
  const closing = f.closing ? `<div style="font-size:14px;line-height:1.5;color:#1f2937;margin:0 0 8px">${esc(f.closing)}</div>` : '';
  const name = f.name ? `<div style="font-size:15px;font-weight:bold;color:#111827;line-height:1.4">${esc(f.name)}</div>` : '';

  if (f.style === 'compact') {
    const line = [f.name ? `<b style="color:#111827">${esc(f.name)}</b>` : '', role, ...reach].filter(Boolean).join(' <span style="color:#cbd5e1">·</span> ');
    return `<div style="font-family:Helvetica,Arial,sans-serif">${closing}<div style="${muted}">${line}</div></div>`;
  }
  const details = `${name}${role ? `<div style="${muted}">${role}</div>` : ''}${reach.length ? `<div style="${muted}">${reach.join(' <span style="color:#cbd5e1">·</span> ')}</div>` : ''}`;
  const picture = logo ? `<td style="padding:0 14px 0 0;vertical-align:middle"><img src="${esc(logo)}" width="48" height="48" alt="" style="display:block;border-radius:8px"></td>` : '';
  const edge = f.style === 'divider' ? 'border-left:3px solid #4f46e5;padding:2px 0 2px 12px' : 'padding:0';
  return `<div style="font-family:Helvetica,Arial,sans-serif">${closing}<table role="presentation" cellpadding="0" cellspacing="0"><tr>${picture}<td style="${edge};vertical-align:middle">${details}</td></tr></table></div>`;
}
