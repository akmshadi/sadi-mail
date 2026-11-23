// A small IMAP client: sign in, open the inbox, and bring back messages that arrived since last time.
// It only ever reads (BODY.PEEK): nothing on the server is marked, moved or deleted.
import { Conn, type Dial, type Security, within } from './wire';

export interface ImapAccount { host: string; port: number; security: Security; username: string; password: string }
export interface ImapState { uidValidity: number | null; lastUid: number | null }
export interface ImapResult { state: ImapState; messages: { uid: number; bytes: Uint8Array }[]; skipped: number; more: boolean; firstRun: boolean }

const MAX_BYTES = 25 * 1024 * 1024;
const quote = (s: string) => `"${s.replace(/[\\"]/g, '\\$&')}"`;

class Session {
  private n = 0;
  constructor(private c: Conn) {}

  /** Send one command and collect everything the server says until its tagged answer. */
  async run(text: string, what: string): Promise<{ lines: string[]; literals: Uint8Array[] }> {
    const tag = `R${++this.n}`;
    await this.c.write(`${tag} ${text}\r\n`);
    const lines: string[] = [];
    const literals: Uint8Array[] = [];
    for (;;) {
      let line = await this.c.line();
      // A line ending in {N} is followed by N raw bytes, then the rest of the line.
      for (let m = /\{(\d+)\}$/.exec(line); m; m = /\{(\d+)\}$/.exec(line)) {
        literals.push(await this.c.bytes(Number(m[1])));
        line = `${line.slice(0, m.index)}{literal}${await this.c.line()}`;
      }
      if (line.startsWith(`${tag} `)) {
        if (!/^\S+ OK\b/i.test(line)) throw new Error(`${what}: ${line.slice(tag.length + 1).slice(0, 200)}`);
        return { lines, literals };
      }
      lines.push(line);
    }
  }
}

async function open(dial: Dial, a: ImapAccount): Promise<{ c: Conn; s: Session }> {
  const c = new Conn(await dial(a.host, a.port, a.security));
  try {
    const hello = await c.line();
    if (!/^\* OK/i.test(hello)) throw new Error(`Connecting: ${hello.slice(0, 200)}`);
    const s = new Session(c);
    if (a.security === 'starttls') {
      await s.run('STARTTLS', 'Starting TLS');
      c.upgrade();
    }
    await s.run(`LOGIN ${quote(a.username)} ${quote(a.password)}`, 'Signing in');
    return { c, s };
  } catch (err) {
    await c.close();
    throw err;
  }
}

const numberIn = (lines: string[], pattern: RegExp) => { for (const l of lines) { const m = pattern.exec(l); if (m) return Number(m[1]); } return null; };

/** Sign in and open the inbox: proves the account works and reports how many messages are there. */
export async function imapCheck(dial: Dial, a: ImapAccount): Promise<{ messages: number }> {
  let conn: Conn | undefined;
  return within(20_000, 'The IMAP server', (async () => {
    const { c, s } = await open(dial, a);
    conn = c;
    try {
      const box = await s.run('EXAMINE INBOX', 'Opening the inbox');
      await s.run('LOGOUT', 'Leaving').catch(() => undefined);
      return { messages: numberIn(box.lines, /^\* (\d+) EXISTS/i) ?? 0 };
    } finally {
      await c.close();
    }
  })(), () => void conn?.close());
}

/**
 * Fetch mail newer than the last one seen, oldest first, a few at a time. The first visit to an
 * inbox only notes where it ends, so connecting an old account does not pull its whole history.
 */
export async function imapFetchNew(dial: Dial, a: ImapAccount, state: ImapState, limit = 10): Promise<ImapResult> {
  let conn: Conn | undefined;
  return within(50_000, 'The IMAP server', (async () => {
    const { c, s } = await open(dial, a);
    conn = c;
    try {
      const box = await s.run('EXAMINE INBOX', 'Opening the inbox');
      const validity = numberIn(box.lines, /\[UIDVALIDITY (\d+)\]/i) ?? 0;
      const next = numberIn(box.lines, /\[UIDNEXT (\d+)\]/i);
      if (state.uidValidity !== validity || state.lastUid === null) {
        let last = next !== null ? next - 1 : 0;
        if (next === null) {
          const all = await s.run('UID SEARCH ALL', 'Reading the inbox');
          for (const l of all.lines) if (/^\* SEARCH/i.test(l)) for (const n of l.split(' ').slice(2).map(Number)) if (n > last) last = n;
        }
        await s.run('LOGOUT', 'Leaving').catch(() => undefined);
        return { state: { uidValidity: validity, lastUid: last }, messages: [], skipped: 0, more: false, firstRun: true };
      }

      const found = await s.run(`UID SEARCH UID ${state.lastUid + 1}:*`, 'Looking for new mail');
      const uids: number[] = [];
      for (const l of found.lines) if (/^\* SEARCH/i.test(l)) for (const n of l.split(' ').slice(2).map(Number)) if (Number.isFinite(n) && n > state.lastUid) uids.push(n);
      uids.sort((x, y) => x - y);
      const batch = uids.slice(0, limit);
      const messages: { uid: number; bytes: Uint8Array }[] = [];
      let last = state.lastUid;
      let skipped = 0;
      if (batch.length) {
        const sizes = new Map<number, number>();
        const listed = await s.run(`UID FETCH ${batch.join(',')} (UID RFC822.SIZE)`, 'Reading message sizes');
        for (const l of listed.lines) {
          const uid = /\bUID (\d+)/i.exec(l);
          const size = /\bRFC822\.SIZE (\d+)/i.exec(l);
          if (uid && size) sizes.set(Number(uid[1]), Number(size[1]));
        }
        for (const uid of batch) {
          if ((sizes.get(uid) ?? 0) > MAX_BYTES) { skipped++; last = uid; continue; }
          const got = await s.run(`UID FETCH ${uid} (UID BODY.PEEK[])`, 'Reading a message');
          const bytes = got.literals[0];
          if (bytes?.length) messages.push({ uid, bytes });
          last = uid;
        }
      }
      await s.run('LOGOUT', 'Leaving').catch(() => undefined);
      return { state: { uidValidity: validity, lastUid: last }, messages, skipped, more: uids.length > batch.length, firstRun: false };
    } finally {
      await c.close();
    }
  })(), () => void conn?.close());
}
