// Pure helpers for the mail importer (scripts/import.mjs). No Node imports, so the
// Workers test runtime can load this file and test it directly.

const MAIL_FOLDERS = ['inbox', 'archive', 'sent', 'spam', 'trash'];
const NL = 10;
const CR = 13;
const GT = 62;
const FROM = [70, 114, 111, 109, 32]; // "From "

const startsWithFrom = (line, at) => FROM.every((b, i) => line[at + i] === b);
const isBlank = (line) => line.length === 0 || (line.length === 1 && line[0] === CR);

/** A ">From " line (any number of ">") was quoted by the mbox writer; one ">" comes off. */
function quotedFrom(line) {
  let i = 0;
  while (line[i] === GT) i++;
  return i > 0 && startsWithFrom(line, i);
}

function concat(parts, total) {
  const out = new Uint8Array(total ?? parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Split an mbox file as it streams in. A message starts at a "From " line that opens the file or
 * follows a blank line; that separator line is not part of the message, and neither is the blank
 * line before the next separator.
 *
 * push(chunk) and end() return the messages finished so far as
 * { start, end, bytes }: start/end are byte offsets of the message in the file (so it can be read
 * again later without splitting the whole file), bytes is that stretch of the file as written,
 * still quoted. Pass bytes through unquoteMbox() to get the original message.
 */
export function createMboxSplitter() {
  let offset = 0; // file offset of the first byte not yet seen
  let carry = []; // pieces of an unfinished line
  let carryLen = 0;
  let current = null; // { start, lines: [{ bytes, end }] }
  let lastBlank = true;
  const done = [];

  function finish() {
    if (!current) return;
    const lines = current.lines;
    if (lines.length && isBlank(lines[lines.length - 1].bytes)) lines.pop();
    const end = lines.length ? lines[lines.length - 1].end : current.start;
    const total = end - current.start;
    const out = new Uint8Array(total);
    let at = 0;
    for (const l of lines) {
      out.set(l.bytes, at);
      at += l.bytes.length;
      if (at < total) out[at++] = NL;
    }
    done.push({ start: current.start, end, bytes: out });
    current = null;
  }

  function onLine(line, end) {
    if (lastBlank && startsWithFrom(line, 0)) {
      finish();
      current = { start: end, lines: [] };
      lastBlank = false;
      return;
    }
    if (current) current.lines.push({ bytes: line, end });
    lastBlank = isBlank(line);
  }

  return {
    push(chunk) {
      let start = 0;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] !== NL) continue;
        let line = chunk.subarray(start, i);
        if (carryLen) {
          carry.push(line);
          line = concat(carry, carryLen + line.length);
          carry = [];
          carryLen = 0;
        } else {
          line = line.slice(); // keep our own copy; the caller may reuse its buffer
        }
        onLine(line, offset + i + 1);
        start = i + 1;
      }
      if (start < chunk.length) {
        const rest = chunk.slice(start);
        carry.push(rest);
        carryLen += rest.length;
      }
      offset += chunk.length;
      return done.splice(0);
    },
    end() {
      if (carryLen) onLine(concat(carry, carryLen), offset);
      carry = [];
      carryLen = 0;
      finish();
      return done.splice(0);
    },
  };
}

/** Undo mbox ">From " quoting in one message's bytes. */
export function unquoteMbox(bytes) {
  const parts = [];
  let start = 0;
  let total = 0;
  for (let i = 0; i <= bytes.length; i++) {
    if (i < bytes.length && bytes[i] !== NL) continue;
    let line = bytes.subarray(start, i < bytes.length ? i + 1 : i);
    if (quotedFrom(line)) line = line.subarray(1);
    parts.push(line);
    total += line.length;
    start = i + 1;
  }
  return concat(parts, total);
}

/** Split a whole mbox held in memory into its messages, unquoted. */
export function splitMbox(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const splitter = createMboxSplitter();
  return [...splitter.push(bytes), ...splitter.end()].map((m) => unquoteMbox(m.bytes));
}

/**
 * Flags from a Maildir file name: "1700000000.M1P2.host:2,FS".
 * S seen, F flagged, R replied, D draft, T trashed. Some systems write ";" or "!" for ":".
 */
export function maildirFlags(filename) {
  const m = /[:;!]2,([A-Za-z]*)$/.exec(filename);
  const f = m ? m[1] : '';
  return { seen: f.includes('S'), flagged: f.includes('F'), replied: f.includes('R'), draft: f.includes('D'), trashed: f.includes('T') };
}

/** Delivery time from a Maildir file name, which starts with seconds since 1970. Null if it does not. */
export function maildirDate(filename, now = Date.now()) {
  const m = /^(\d{9,11})\./.exec(filename);
  if (!m) return null;
  const ms = Number(m[1]) * 1000;
  return ms > Date.UTC(1990, 0, 1) && ms < now + 86_400_000 ? ms : null;
}

/**
 * The few headers the importer needs, read from the top of a message without a full parse:
 * Message-ID, Date, and the read/flag markers mail programs leave in mbox files.
 */
export function readHeaders(bytes) {
  const top = bytes.subarray(0, Math.min(bytes.length, 256 * 1024));
  let end = top.length;
  for (let i = 0; i < top.length - 1; i++) {
    if (top[i] === NL && (top[i + 1] === NL || (top[i + 1] === CR && top[i + 2] === NL))) {
      end = i;
      break;
    }
  }
  const text = new TextDecoder('latin1').decode(top.subarray(0, end)).replace(/\r?\n[ \t]+/g, ' ');
  const headers = new Map();
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    if (!headers.has(key)) headers.set(key, line.slice(colon + 1).trim());
  }
  const rawId = headers.get('message-id') ?? '';
  const messageId = /<([^<>\s]+)>/.exec(rawId)?.[1] ?? (rawId && !/\s/.test(rawId) ? rawId : null);
  const rawDate = (headers.get('date') ?? '').replace(/\([^)]*\)/g, '').trim();
  const parsed = rawDate ? Date.parse(rawDate) : NaN;
  const labels = headers.get('x-gmail-labels');
  return {
    messageId,
    date: Number.isFinite(parsed) ? parsed : null,
    gmailLabels: labels ? labels.split(',').map((l) => l.trim().replace(/^"|"$/g, '')).filter(Boolean) : null,
    status: headers.get('status') ?? null,
    xStatus: headers.get('x-status') ?? null,
    mozillaStatus: headers.get('x-mozilla-status') ?? null,
  };
}

/** Read and starred state recorded inside an mbox message, or null where nothing says. */
export function mboxState(h) {
  if (h.gmailLabels) {
    const set = new Set(h.gmailLabels.map((l) => l.toLowerCase()));
    return { read: !set.has('unread'), starred: set.has('starred') };
  }
  if (h.mozillaStatus && /^[0-9a-f]{1,4}$/i.test(h.mozillaStatus)) {
    const v = parseInt(h.mozillaStatus, 16);
    return { read: (v & 0x1) !== 0, starred: (v & 0x4) !== 0 };
  }
  return {
    read: h.status !== null ? h.status.includes('R') : null,
    starred: h.xStatus !== null ? h.xStatus.includes('F') : null,
  };
}

/**
 * Gmail Takeout puts every message in one mbox and lists its labels in X-Gmail-Labels.
 * Returns a folder name that the normal folder mapping understands.
 */
export function gmailFolder(labels) {
  const set = new Set(labels.map((l) => l.toLowerCase()));
  if (set.has('spam')) return 'Spam';
  if (set.has('trash')) return 'Trash';
  if (set.has('drafts') || set.has('draft')) return 'Drafts';
  if (set.has('sent')) return 'Sent';
  if (set.has('inbox')) return 'Inbox';
  return 'All Mail';
}

const BY_NAME = {
  inbox: 'inbox',
  sent: 'sent', 'sent items': 'sent', 'sent mail': 'sent', 'sent messages': 'sent',
  archive: 'archive', archives: 'archive', 'all mail': 'archive',
  junk: 'spam', spam: 'spam', 'junk e-mail': 'spam', 'junk email': 'spam', 'junk mail': 'spam', 'bulk mail': 'spam',
  trash: 'trash', bin: 'trash', deleted: 'trash', 'deleted items': 'trash', 'deleted messages': 'trash',
  drafts: 'skip', draft: 'skip',
};
const BY_SPECIAL_USE = { '\\Inbox': 'inbox', '\\Sent': 'sent', '\\Junk': 'spam', '\\Trash': 'trash', '\\Archive': 'archive', '\\All': 'archive', '\\Drafts': 'skip' };

/**
 * Which Sadi Mail folder mail from an old folder goes to. Returns null for a folder that is skipped.
 * Order: an override from --map, then the server's own marking of the folder (IMAP special use),
 * then the folder's name, then archive.
 */
export function mapFolder(name, { specialUse = null, overrides = new Map() } = {}) {
  const pick = (v) => (v === 'skip' ? null : v);
  const own = overrides.get(name.toLowerCase());
  if (own) return pick(own);
  if (specialUse && BY_SPECIAL_USE[specialUse]) return pick(BY_SPECIAL_USE[specialUse]);
  const plain = name.trim().toLowerCase().replace(/^\[(gmail|google mail)\][/.]/, '').replace(/^inbox[/.](?=.)/, '');
  if (BY_NAME[plain]) return pick(BY_NAME[plain]);
  const last = plain.split('/').pop() ?? plain;
  if (BY_NAME[last]) return pick(BY_NAME[last]);
  return 'archive';
}

/** Turn --map "Old Name=archive" values into a lookup. Throws a plain-English Error on a bad one. */
export function parseMap(values) {
  const out = new Map();
  for (const value of values ?? []) {
    const eq = value.lastIndexOf('=');
    const from = eq > 0 ? value.slice(0, eq).trim() : '';
    const to = eq > 0 ? value.slice(eq + 1).trim().toLowerCase() : '';
    if (!from || ![...MAIL_FOLDERS, 'skip'].includes(to)) {
      throw new Error(`--map "${value}" is not understood. Write it as "Old folder=archive"; the right side must be one of ${MAIL_FOLDERS.join(', ')} or skip.`);
    }
    out.set(from.toLowerCase(), to);
  }
  return out;
}

/** "2024-01-31" → midnight UTC that day, in ms. Throws on anything else. */
export function parseSince(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
  const ms = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
  if (!m || !Number.isFinite(ms) || new Date(ms).getUTCDate() !== Number(m[3])) throw new Error(`--since "${value}" is not a date. Write it as YYYY-MM-DD, for example 2024-01-31.`);
  return ms;
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export const MAIL_FOLDER_ORDER = ['inbox', 'sent', 'spam', 'trash', 'archive'];
