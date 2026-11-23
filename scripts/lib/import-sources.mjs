// Where the importer reads mail from: a folder of .eml files, an mbox file, a Maildir, or an IMAP server.
// Every source has the same shape:
//   label            what to call it in messages
//   plan()           → list of items (no message bytes): { where, folder, specialUse?, relay?, skip?,
//                      size, date, internalDate, messageId, read, starred, ref }
//   read(items)      async generator → { item, bytes } or { item, error }, in the order given
//   close()
import { createReadStream } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';
import { createMboxSplitter, gmailFolder, maildirDate, maildirFlags, mboxState, readHeaders, unquoteMbox } from './import-formats.mjs';

const HEAD_BYTES = 256 * 1024;

async function readHead(path) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) yield* walk(path);
    else if (e.isFile()) yield path;
  }
}

async function* readFiles(items) {
  for (const item of items) {
    try {
      yield { item, bytes: await readFile(item.ref) };
    } catch (err) {
      yield { item, error: `could not read the file (${err.code ?? err.message})` };
    }
  }
}

// ---------- a folder of .eml files ----------

export async function emlSource(dir) {
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`"${dir}" is not a folder.`);
  return {
    label: `.eml files in ${dir}`,
    async plan() {
      const items = [];
      for await (const path of walk(dir)) {
        if (extname(path).toLowerCase() !== '.eml') continue;
        const rel = relative(dir, path);
        const parts = rel.split(sep);
        const folder = parts.length > 1 ? parts.slice(0, -1).join('/') : 'INBOX';
        const { size } = await stat(path);
        const h = readHeaders(await readHead(path));
        items.push({ where: path, folder, size, date: h.date, internalDate: null, messageId: h.messageId, read: null, starred: null, ref: path });
      }
      return items;
    },
    read: readFiles,
    async close() {},
  };
}

// ---------- Maildir ----------

const hasMaildir = async (dir) => {
  for (const name of ['cur', 'new']) {
    const s = await stat(join(dir, name)).catch(() => null);
    if (s?.isDirectory()) return true;
  }
  return false;
};

async function findMaildirs(root, dir = root, out = []) {
  if (await hasMaildir(dir)) out.push(dir);
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (!e.isDirectory() || ['cur', 'new', 'tmp'].includes(e.name)) continue;
    await findMaildirs(root, join(dir, e.name), out);
  }
  return out;
}

/** ".Sent" or ".Archive.2023" (Maildir++) or plain "Sent/2023" → "Sent", "Archive/2023". The top is INBOX. */
function maildirFolderName(root, dir) {
  const rel = relative(root, dir);
  if (!rel) return 'INBOX';
  return rel
    .split(sep)
    .map((part) => (part.startsWith('.') ? part.slice(1).split('.').join('/') : part))
    .join('/');
}

export async function maildirSource(root) {
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`"${root}" is not a folder.`);
  return {
    label: `Maildir ${root}`,
    async plan() {
      const dirs = await findMaildirs(root);
      if (dirs.length === 0) throw new Error(`No Maildir folders (folders with cur/ or new/ inside) were found in "${root}".`);
      const items = [];
      for (const dir of dirs) {
        const folder = maildirFolderName(root, dir);
        for (const sub of ['cur', 'new']) {
          const entries = await readdir(join(dir, sub), { withFileTypes: true }).catch(() => []);
          for (const e of entries) {
            if (!e.isFile() || e.name.startsWith('.')) continue;
            const path = join(dir, sub, e.name);
            const flags = maildirFlags(e.name);
            const { size } = await stat(path);
            const h = readHeaders(await readHead(path));
            items.push({
              where: path,
              folder,
              // A message marked as a draft is skipped; one marked as deleted goes to Trash rather than being lost.
              skip: flags.draft ? 'drafts are skipped' : undefined,
              relay: flags.trashed ? 'trash' : undefined,
              size,
              date: h.date,
              internalDate: maildirDate(e.name),
              messageId: h.messageId,
              read: sub === 'new' ? false : flags.seen,
              starred: flags.flagged,
              ref: path,
            });
          }
        }
      }
      return items;
    },
    read: readFiles,
    async close() {},
  };
}

// ---------- mbox ----------

async function mboxFiles(path) {
  const info = await stat(path).catch(() => null);
  if (!info) throw new Error(`"${path}" does not exist.`);
  if (info.isFile()) return [path];
  // A folder of mbox files, as Thunderbird keeps them: every plain file except its .msf indexes.
  const out = [];
  for await (const file of walk(path)) {
    const name = basename(file);
    if (name.startsWith('.') || ['.msf', '.dat', '.json', '.html'].includes(extname(name).toLowerCase())) continue;
    out.push(file);
  }
  return out;
}

export async function mboxSource(path) {
  const files = await mboxFiles(path);
  return {
    label: files.length === 1 ? `mbox file ${files[0]}` : `${files.length} mbox files in ${path}`,
    async plan() {
      const items = [];
      for (const file of files) {
        const name = basename(file).replace(/\.mbox$/i, '');
        const splitter = createMboxSplitter();
        let n = 0;
        const take = (messages) => {
          for (const m of messages) {
            n++;
            const h = readHeaders(m.bytes);
            const state = mboxState(h);
            items.push({
              where: `${file}, message ${n}`,
              folder: h.gmailLabels ? gmailFolder(h.gmailLabels) : name,
              size: m.end - m.start,
              date: h.date,
              internalDate: null,
              messageId: h.messageId,
              read: state.read,
              starred: state.starred,
              ref: { file, start: m.start, end: m.end },
            });
          }
        };
        for await (const chunk of createReadStream(file)) take(splitter.push(chunk));
        take(splitter.end());
      }
      return items;
    },
    async *read(items) {
      const handles = new Map();
      try {
        for (const item of items) {
          try {
            const { file, start, end } = item.ref;
            if (!handles.has(file)) handles.set(file, await open(file, 'r'));
            const buffer = Buffer.alloc(end - start);
            const { bytesRead } = await handles.get(file).read(buffer, 0, buffer.length, start);
            if (bytesRead !== buffer.length) throw new Error('the file changed since it was read');
            yield { item, bytes: Buffer.from(unquoteMbox(buffer)) };
          } catch (err) {
            yield { item, error: `could not read it from the mbox file (${err.code ?? err.message})` };
          }
        }
      } finally {
        for (const h of handles.values()) await h.close();
      }
    },
    async close() {},
  };
}

// ---------- IMAP (read-only) ----------

export async function loadImapFlow() {
  try {
    return (await import('imapflow')).ImapFlow;
  } catch {
    throw new Error('Reading from an IMAP server needs the "imapflow" package, which is not installed.\nInstall it with:  pnpm add -O imapflow   (or: npm install imapflow)');
  }
}

/**
 * Connects with TLS (port 993) or STARTTLS (any other port; a server that cannot upgrade is refused).
 * Every folder is opened read-only (EXAMINE) and messages are fetched with BODY.PEEK, so nothing on
 * the old server changes and nothing is marked as read.
 */
export async function imapSource({ host, port, user, password, since }) {
  const ImapFlow = await loadImapFlow();
  const secure = port === 993;
  const client = new ImapFlow({ host, port, secure, doSTARTTLS: secure ? undefined : true, auth: { user, pass: password }, logger: false });
  client.on('error', () => {}); // a dropped connection surfaces on the next command instead of crashing the run
  try {
    await client.connect();
  } catch (err) {
    const why = err.authenticationFailed ? 'the user name or password was not accepted' : (err.responseText ?? err.code ?? err.message);
    throw new Error(`Could not sign in to ${host}:${port}: ${why}.`);
  }

  return {
    label: `IMAP server ${host} as ${user}`,
    async plan() {
      const items = [];
      const folders = await client.list();
      for (const f of folders) {
        if (f.flags?.has('\\Noselect') || f.flags?.has('\\NonExistent')) continue;
        const lock = await client.getMailboxLock(f.path, { readOnly: true });
        try {
          if (!client.mailbox || client.mailbox.exists === 0) continue;
          let range = '1:*';
          if (since !== null) {
            const uids = await client.search({ since: new Date(since) }, { uid: true });
            if (!uids || uids.length === 0) continue;
            range = uids.join(',');
          }
          for await (const msg of client.fetch(range, { uid: true, flags: true, size: true, internalDate: true, envelope: true }, { uid: true })) {
            const flags = msg.flags ?? new Set();
            const internal = msg.internalDate ? new Date(msg.internalDate).getTime() : null;
            items.push({
              where: `${f.path}, message number ${msg.uid}`,
              folder: f.path,
              specialUse: f.specialUse ?? null,
              skip: flags.has('\\Draft') ? 'drafts are skipped' : undefined,
              relay: flags.has('\\Deleted') ? 'trash' : undefined,
              size: msg.size ?? 0,
              date: internal,
              internalDate: internal,
              messageId: msg.envelope?.messageId ? (/<([^<>\s]+)>/.exec(msg.envelope.messageId)?.[1] ?? msg.envelope.messageId) : null,
              read: flags.has('\\Seen'),
              starred: flags.has('\\Flagged'),
              ref: { path: f.path, uid: msg.uid },
            });
          }
        } finally {
          lock.release();
        }
      }
      return items;
    },
    async *read(items) {
      let lock = null;
      try {
        for (const item of items) {
          try {
            if (!lock || lock.path !== item.ref.path) {
              lock?.release();
              lock = null;
              lock = await client.getMailboxLock(item.ref.path, { readOnly: true });
            }
            const msg = await client.fetchOne(String(item.ref.uid), { uid: true, source: true }, { uid: true });
            if (!msg || !msg.source) throw new Error('the server no longer has it');
            yield { item, bytes: msg.source };
          } catch (err) {
            yield { item, error: `could not fetch it from the server (${err.responseText ?? err.message})` };
          }
        }
      } finally {
        lock?.release();
      }
    },
    async close() {
      await client.logout().catch(() => client.close());
    },
  };
}
