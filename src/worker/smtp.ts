// A small SMTP client: enough to sign in to a mail server and hand it one message.
import { Conn, type Dial, type Security, b64text, within } from './wire';

export interface SmtpAccount { host: string; port: number; security: Security; username: string; password: string }
export interface MimeMessage {
  from: { name: string; email: string };
  to: { name: string; email: string }[];
  cc: { name: string; email: string }[];
  bcc: { name: string; email: string }[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo: string | null;
  references: string[];
  attachments: { filename: string; mime: string; base64: string }[];
}

async function reply(c: Conn): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  for (;;) {
    const line = await c.line();
    lines.push(line.slice(4));
    if (line.length < 4 || line[3] !== '-') return { code: Number(line.slice(0, 3)), lines };
  }
}

async function command(c: Conn, send: string | null, expect: number[], what: string): Promise<string[]> {
  if (send !== null) await c.write(`${send}\r\n`);
  const r = await reply(c);
  if (!expect.includes(r.code)) throw new Error(`${what}: the server answered ${r.code} ${r.lines.join(' ').slice(0, 200)}`);
  return r.lines;
}

async function open(dial: Dial, a: SmtpAccount, helo: string): Promise<Conn> {
  const c = new Conn(await dial(a.host, a.port, a.security));
  try {
    await command(c, null, [220], 'Connecting');
    let caps = await command(c, `EHLO ${helo}`, [250], 'Greeting');
    if (a.security === 'starttls') {
      if (!caps.some((l) => /^STARTTLS/i.test(l))) throw new Error('The server does not offer STARTTLS on this port. Try port 465 with TLS.');
      await command(c, 'STARTTLS', [220], 'Starting TLS');
      c.upgrade();
      caps = await command(c, `EHLO ${helo}`, [250], 'Greeting');
    }
    if (a.username) {
      const auth = caps.find((l) => /^AUTH\b/i.test(l)) ?? '';
      if (/\bPLAIN\b/i.test(auth) || !/\bLOGIN\b/i.test(auth)) {
        await command(c, `AUTH PLAIN ${b64text(`\0${a.username}\0${a.password}`)}`, [235], 'Signing in');
      } else {
        await command(c, 'AUTH LOGIN', [334], 'Signing in');
        await command(c, b64text(a.username), [334], 'Signing in');
        await command(c, b64text(a.password), [235], 'Signing in');
      }
    }
    return c;
  } catch (err) {
    await c.close();
    throw err;
  }
}

/** Sign in and leave again: proves the host, port, security and password without sending anything. */
export async function smtpCheck(dial: Dial, a: SmtpAccount): Promise<void> {
  let conn: Conn | undefined;
  await within(20_000, 'The SMTP server', (async () => {
    conn = await open(dial, a, 'relay.local');
    await command(conn, 'QUIT', [221, 250], 'Leaving').catch(() => undefined);
    await conn.close();
  })(), () => void conn?.close());
}

export async function smtpSend(dial: Dial, a: SmtpAccount, message: MimeMessage, messageId: string, at: number): Promise<string> {
  const domain = message.from.email.split('@')[1] ?? 'relay.local';
  const raw = buildMime(message, messageId, at);
  let conn: Conn | undefined;
  return within(45_000, 'The SMTP server', (async () => {
    conn = await open(dial, a, domain);
    try {
      await command(conn, `MAIL FROM:<${message.from.email}>`, [250], 'Sender refused');
      for (const p of [...message.to, ...message.cc, ...message.bcc]) await command(conn, `RCPT TO:<${p.email}>`, [250, 251], `Recipient ${p.email} refused`);
      await command(conn, 'DATA', [354], 'Message refused');
      // A line that starts with a dot is doubled, so the server does not take it for the end of the message.
      await conn.write(raw.replace(/\r\n\./g, '\r\n..').replace(/^\./, '..'));
      const done = await command(conn, '\r\n.', [250], 'Message refused');
      await command(conn, 'QUIT', [221, 250], 'Leaving').catch(() => undefined);
      return done.join(' ').slice(0, 200);
    } finally {
      await conn.close();
    }
  })(), () => void conn?.close());
}

// ---------- the message itself ----------

const ascii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** A header value that may hold any language, as RFC 2047 encoded words of safe length. */
function word(s: string): string {
  if (ascii(s)) return s;
  const parts: string[] = [];
  let chunk = '';
  for (const ch of s) {
    if (new TextEncoder().encode(chunk + ch).length > 42) { parts.push(chunk); chunk = ''; }
    chunk += ch;
  }
  if (chunk) parts.push(chunk);
  return parts.map((p) => `=?UTF-8?B?${b64text(p)}?=`).join('\r\n ');
}

const person = (p: { name: string; email: string }) => (p.name ? `${ascii(p.name) ? `"${p.name.replace(/["\\]/g, '')}"` : word(p.name)} <${p.email}>` : p.email);
const wrap76 = (b: string) => (b.match(/.{1,76}/g) ?? []).join('\r\n');
const part = (type: string, body: string) => `Content-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(b64text(body))}`;

export function buildMime(m: MimeMessage, messageId: string, at: number): string {
  const mark = messageId.replace(/[^a-z0-9]/gi, '').slice(0, 24);
  const head = [
    `From: ${person(m.from)}`,
    `To: ${m.to.map(person).join(',\r\n ')}`,
    ...(m.cc.length ? [`Cc: ${m.cc.map(person).join(',\r\n ')}`] : []),
    `Subject: ${word(m.subject.replace(/[\r\n]+/g, ' '))}`,
    `Date: ${new Date(at).toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${messageId}>`,
    ...(m.inReplyTo ? [`In-Reply-To: <${m.inReplyTo}>`] : []),
    ...(m.references.length ? [`References: ${m.references.map((r) => `<${r}>`).join('\r\n ')}`] : []),
    'MIME-Version: 1.0',
  ];
  let body = part('text/plain', m.text);
  if (m.html) {
    const b = `alt-${mark}`;
    body = `Content-Type: multipart/alternative; boundary="${b}"\r\n\r\n--${b}\r\n${part('text/plain', m.text)}\r\n--${b}\r\n${part('text/html', m.html)}\r\n--${b}--`;
  }
  if (m.attachments.length) {
    const b = `mix-${mark}`;
    const files = m.attachments.map((a) => {
      const name = ascii(a.filename) ? a.filename.replace(/["\\\r\n]/g, '') : word(a.filename);
      const type = /^[\w.+-]+\/[\w.+-]+$/.test(a.mime) ? a.mime : 'application/octet-stream';
      return `--${b}\r\nContent-Type: ${type}; name="${name}"\r\nContent-Disposition: attachment; filename="${name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(a.base64)}`;
    });
    body = `Content-Type: multipart/mixed; boundary="${b}"\r\n\r\n--${b}\r\n${body}\r\n${files.join('\r\n')}\r\n--${b}--`;
  }
  return `${head.join('\r\n')}\r\n${body}`;
}
