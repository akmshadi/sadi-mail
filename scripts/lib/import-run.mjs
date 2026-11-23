// The importer itself. scripts/import.mjs calls main(); it is split out so it can be run with a
// stand-in for fetch and the terminal.
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { MAIL_FOLDER_ORDER, formatBytes, mapFolder, parseMap, parseSince } from './import-formats.mjs';
import { emlSource, imapSource, loadImapFlow, maildirSource, mboxSource } from './import-sources.mjs';

const MAX_BYTES = 25 * 1024 * 1024;
const CONCURRENCY = 3;
const RETRIES = 3;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const USAGE = `Bring an existing mailbox into Sadi Mail.

Usage:
  pnpm import-mail <source> --address <email> [options]
  (or: node scripts/import.mjs <source> --address <email> [options])

Note: write "pnpm import-mail", not "pnpm import" - "pnpm import" is a different, built-in pnpm command.

Where the mail comes from (pick one):
  --eml <folder>        every .eml file in the folder and its subfolders (a subfolder's name is its folder)
  --mbox <file>         an mbox file (or a folder of them, as Thunderbird keeps them)
  --maildir <folder>    a Maildir, with its cur/ and new/ folders and any .Folder subfolders
  --imap <host>         an IMAP server, read-only. Needs --user. The password is read from the
                        IMAP_PASSWORD environment variable, or asked for without showing it.
    --user <name>       the IMAP user name
    --port <number>     default 993 (TLS). Any other port must offer STARTTLS.

Where it goes:
  --address <email>     the Sadi Mail address to file the mail under (required)
  --url <address>       Sadi Mail's web address (default http://localhost:8787)
                        Sign-in, when Sadi Mail is not a local development server:
                          SADI_MAIL_TOKEN                                   sent as "Authorization: Bearer"
                          CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET  a Cloudflare Access service token

Choosing what to bring:
  --map "Old Name=archive"  send an old folder to inbox, archive, sent, spam or trash, or "skip" it.
                        Can be given more than once. Without it: INBOX to inbox; Sent, Sent Items and
                        Sent Mail to sent; Archive and All Mail to archive; Junk and Spam to spam;
                        Trash and Deleted to trash; Drafts are skipped; anything else to archive.
  --only <folder>       only this old folder (its name) or Sadi Mail folder (inbox, sent, ...)
  --since <YYYY-MM-DD>  only mail from this day on

Running:
  --dry-run             list what would be brought over, and upload nothing
  --yes                 do not ask before uploading
  --help                show this

Running it again is safe: messages Sadi Mail already has are skipped.

Examples:
  pnpm import-mail --eml ~/Exports/old-mail --address me@example.com --dry-run
  pnpm import-mail --mbox ~/Downloads/Takeout/Mail/All.mbox --address me@example.com --map "All Mail=archive"
  IMAP_PASSWORD=... pnpm import-mail --imap imap.example.com --user me@example.com --address me@example.com --since 2024-01-01 --url https://mail.example.com
`;

class UploadError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

function table(rows, rightAligned = []) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => '  ' + r.map((cell, i) => (rightAligned.includes(i) ? String(cell).padStart(widths[i]) : String(cell).padEnd(widths[i]))).join('   ').trimEnd()).join('\n');
}

/** Ask for a password without showing what is typed. */
function askHidden(question, io) {
  return new Promise((resolve, reject) => {
    const stdin = io.stdin;
    if (!stdin.isTTY) return reject(new Error('No IMAP password: set IMAP_PASSWORD, or run this in a terminal so it can ask for it.'));
    io.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const finish = (err) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      io.stdout.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003') return finish(new Error('Stopped.'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function confirm(question, io) {
  const rl = createInterface({ input: io.stdin, output: io.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

function authHeaders(env) {
  const headers = {};
  if (env.SADI_MAIL_TOKEN) headers.authorization = `Bearer ${env.SADI_MAIL_TOKEN}`;
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    headers['cf-access-client-id'] = env.CF_ACCESS_CLIENT_ID;
    headers['cf-access-client-secret'] = env.CF_ACCESS_CLIENT_SECRET;
  }
  return headers;
}

const networkReason = (err) => {
  const code = err?.cause?.code ?? err?.cause?.errors?.[0]?.code ?? err?.code;
  if (err?.name === 'TimeoutError') return 'Sadi Mail did not answer within two minutes';
  return `could not reach Sadi Mail${code ? ` (${code})` : ''}`;
};

/** Upload one message, retrying a few times when the failure might be temporary. */
async function upload(fetchImpl, base, headers, address, item, bytes, wait = sleep) {
  const query = new URLSearchParams({ address, folder: item.relay, read: item.read === false ? '0' : '1', starred: item.starred ? '1' : '0' });
  if (item.internalDate) query.set('date', String(item.internalDate));
  let lastReason = '';
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) await wait(1000 * 2 ** (attempt - 1));
    let response;
    try {
      response = await fetchImpl(`${base}/api/import/message?${query}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'message/rfc822' },
        body: bytes,
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      lastReason = networkReason(err);
      continue;
    }
    const text = await response.text().catch(() => '');
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON: a proxy or sign-in page answered
    }
    if (response.ok && (body?.status === 'imported' || body?.status === 'duplicate')) return body;
    lastReason = body?.message ? `${body.message} (${response.status})` : `Sadi Mail answered with status ${response.status}`;
    const temporary = response.status >= 500 || response.status === 429 || response.status === 408 || (response.ok && !body);
    if (!temporary) throw new UploadError(lastReason);
  }
  throw new UploadError(`${lastReason}, after ${RETRIES + 1} tries`);
}

/** Run the jobs from an async iterator with a few at a time. Pulling from the iterator is one at a time. */
async function pool(iterable, size, work) {
  const it = iterable[Symbol.asyncIterator]();
  let chain = Promise.resolve();
  const next = () => {
    const p = chain.then(() => it.next());
    chain = p.catch(() => {});
    return p;
  };
  await Promise.all(
    Array.from({ length: size }, async () => {
      for (;;) {
        const r = await next();
        if (r.done) return;
        await work(r.value);
      }
    }),
  );
}

function parse(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const { values } = parseArgs({
    args,
    options: {
      eml: { type: 'string' }, mbox: { type: 'string' }, maildir: { type: 'string' }, imap: { type: 'string' },
      user: { type: 'string' }, port: { type: 'string' }, address: { type: 'string' }, url: { type: 'string' },
      map: { type: 'string', multiple: true }, only: { type: 'string' }, since: { type: 'string' },
      'dry-run': { type: 'boolean' }, yes: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: false,
  });
  return values;
}

/**
 * Returns the exit code: 0 when everything was brought over (or skipped as already there),
 * 1 when some messages failed, 2 when the run could not start.
 */
export async function main(argv, deps = {}) {
  const io = { stdin: deps.stdin ?? process.stdin, stdout: deps.stdout ?? process.stdout, stderr: deps.stderr ?? process.stderr };
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetch ?? fetch;
  const say = (line = '') => io.stdout.write(line + '\n');
  const fail = (message) => {
    io.stderr.write(message + '\n');
    return 2;
  };

  let opts;
  try {
    opts = parse(argv);
  } catch (err) {
    return fail(`${err.message.replace(/\. To specify.*$/s, '.')}\nRun with --help to see the options.`);
  }
  if (opts.help) {
    say(USAGE);
    return 0;
  }

  const sources = ['eml', 'mbox', 'maildir', 'imap'].filter((k) => opts[k] !== undefined);
  if (sources.length !== 1) return fail('Say where the mail comes from with exactly one of --eml, --mbox, --maildir or --imap.\nRun with --help to see the options.');
  const address = (opts.address ?? '').trim().toLowerCase();
  if (!EMAIL.test(address)) return fail('Say which Sadi Mail address the mail belongs to with --address, for example --address me@example.com.');
  const base = (opts.url ?? 'http://localhost:8787').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) return fail(`--url "${opts.url}" should start with http:// or https://.`);

  let overrides;
  let since = null;
  try {
    overrides = parseMap(opts.map);
    if (opts.since) since = parseSince(opts.since);
  } catch (err) {
    return fail(err.message);
  }
  const only = opts.only?.trim().toLowerCase() || null;

  let source;
  try {
    if (opts.eml) source = await emlSource(opts.eml);
    else if (opts.mbox) source = await mboxSource(opts.mbox);
    else if (opts.maildir) source = await maildirSource(opts.maildir);
    else {
      if (!opts.user) return fail('--imap needs --user with the IMAP user name.');
      const port = opts.port ? Number(opts.port) : 993;
      if (!Number.isInteger(port) || port < 1 || port > 65535) return fail(`--port "${opts.port}" is not a port number.`);
      if (!deps.imapSource) await loadImapFlow(); // say it is missing before asking for a password
      const password = env.IMAP_PASSWORD || (deps.askPassword ? await deps.askPassword() : await askHidden(`IMAP password for ${opts.user}: `, io));
      if (!password) return fail('No IMAP password was given.');
      say(`Connecting to ${opts.imap}:${port} (read-only)...`);
      source = await (deps.imapSource ?? imapSource)({ host: opts.imap, port, user: opts.user, password, since });
    }
  } catch (err) {
    return fail(err.message);
  }

  try {
    say(`Reading ${source.label}...`);
    const all = await source.plan();

    // Decide where each message goes, and which are left out and why.
    const skipped = new Map(); // reason → count
    const leaveOut = (reason) => skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
    const tooBig = [];
    let candidates = [];
    for (const item of all) {
      if (item.skip) {
        leaveOut(item.skip);
        continue;
      }
      const relay = item.relay ?? mapFolder(item.folder, { specialUse: item.specialUse, overrides });
      if (!relay) {
        leaveOut(/draft/i.test(item.folder) && !overrides.has(item.folder.toLowerCase()) ? 'drafts are skipped' : 'in a folder set to skip');
        continue;
      }
      if (only && item.folder.toLowerCase() !== only && relay !== only) {
        leaveOut('not in the folder chosen with --only');
        continue;
      }
      const when = item.internalDate ?? item.date;
      if (since !== null && when !== null && when < since) {
        leaveOut('older than --since');
        continue;
      }
      if (item.size > MAX_BYTES) {
        tooBig.push({ ...item, relay });
        continue;
      }
      candidates.push({ ...item, relay });
    }

    // The same message is often in two folders (Gmail keeps everything in All Mail too). Keep the copy in
    // the folder that says the most: inbox, then sent, spam, trash, and archive last.
    candidates = candidates
      .map((item, index) => ({ item, index }))
      .sort((a, b) => MAIL_FOLDER_ORDER.indexOf(a.item.relay) - MAIL_FOLDER_ORDER.indexOf(b.item.relay) || a.index - b.index)
      .map((x) => x.item);
    const seenIds = new Set();
    const chosen = [];
    for (const item of candidates) {
      if (item.messageId) {
        if (seenIds.has(item.messageId)) {
          leaveOut('the same message is also in another folder');
          continue;
        }
        seenIds.add(item.messageId);
      }
      chosen.push(item);
    }
    // Oldest first, so an earlier message is in Sadi Mail before the replies that point to it.
    chosen.sort((a, b) => (a.internalDate ?? a.date ?? Infinity) - (b.internalDate ?? b.date ?? Infinity));

    // ---------- summary ----------
    const groups = new Map();
    for (const item of chosen) {
      const key = `${item.folder}\u0000${item.relay}`;
      const g = groups.get(key) ?? { folder: item.folder, relay: item.relay, count: 0, bytes: 0 };
      g.count++;
      g.bytes += item.size;
      groups.set(key, g);
    }
    const ordered = [...groups.values()].sort((a, b) => MAIL_FOLDER_ORDER.indexOf(a.relay) - MAIL_FOLDER_ORDER.indexOf(b.relay) || a.folder.localeCompare(b.folder));
    const totalBytes = chosen.reduce((n, i) => n + i.size, 0);

    say('');
    say(`Found ${plural(all.length, 'message')} in ${source.label}.`);
    if (chosen.length) {
      say(`To bring into ${address} at ${base}:`);
      say('');
      say(
        table(
          [
            ['Old folder', 'Sadi Mail folder', 'Messages', 'Size'],
            ...ordered.map((g) => [g.folder, g.relay, g.count.toLocaleString('en-US'), formatBytes(g.bytes)]),
            ['Total', '', chosen.length.toLocaleString('en-US'), formatBytes(totalBytes)],
          ],
          [2, 3],
        ),
      );
    } else {
      say('There is nothing to bring over.');
    }
    if (skipped.size || tooBig.length) {
      say('');
      say('Left out:');
      for (const [reason, n] of skipped) say(`  ${plural(n, 'message')}: ${reason}`);
      if (tooBig.length) say(`  ${plural(tooBig.length, 'message')}: larger than 25 MiB, which Sadi Mail cannot store (listed as failed)`);
    }
    say('');

    if (opts['dry-run']) {
      say('Dry run: nothing was uploaded.');
      return 0;
    }
    if (chosen.length === 0 && tooBig.length === 0) return 0;

    // Check that Sadi Mail is there and lets us in before touching any message.
    const headers = authHeaders(env);
    try {
      const r = await fetchImpl(`${base}/api/import/status`, { headers, signal: AbortSignal.timeout(30_000) });
      if (r.status === 401) return fail(`Sadi Mail at ${base} did not accept the sign-in. Set SADI_MAIL_TOKEN, or CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET.`);
      if (r.status === 403) return fail(`The account signed in to Sadi Mail at ${base} is not an owner or admin, and only they can import mail.`);
      if (!r.ok) return fail(`Sadi Mail at ${base} answered with status ${r.status}. Check --url.`);
      await r.text();
    } catch (err) {
      return fail(`Sadi Mail at ${base}: ${networkReason(err)}. Check --url and that Sadi Mail is running.`);
    }

    if (!opts.yes) {
      if (!io.stdin.isTTY) return fail('Add --yes to upload without being asked (there is no terminal to ask in).');
      if (!(await confirm(`Upload ${plural(chosen.length, 'message')} (${formatBytes(totalBytes)})? Type y to continue: `, io))) {
        say('Nothing was uploaded.');
        return 0;
      }
    }

    // ---------- upload ----------
    const counts = { imported: 0, duplicate: 0, failed: 0 };
    const failures = tooBig.map((item) => ({ where: item.where, reason: 'larger than 25 MiB' }));
    counts.failed = failures.length;
    const tty = !!io.stdout.isTTY;
    let lastLen = 0;
    let done = 0;
    const progress = (final = false) => {
      const line = `Uploading: ${done.toLocaleString('en-US')} of ${chosen.length.toLocaleString('en-US')} done · ${counts.imported} imported · ${counts.duplicate} already there · ${counts.failed} failed`;
      if (tty) {
        io.stdout.write('\r' + line.padEnd(lastLen) + (final ? '\n' : ''));
        lastLen = line.length;
      } else if (final || done % 100 === 0) {
        say(line);
      }
    };
    progress();
    await pool(source.read(chosen), CONCURRENCY, async (got) => {
      try {
        if (got.error) throw new UploadError(got.error);
        if (got.bytes.length === 0) throw new UploadError('the message is empty');
        const result = await upload(fetchImpl, base, headers, address, got.item, got.bytes, deps.sleep);
        counts[result.status === 'duplicate' ? 'duplicate' : 'imported']++;
      } catch (err) {
        counts.failed++;
        failures.push({ where: got.item.where, reason: err instanceof UploadError ? err.message : `unexpected error: ${err.message}` });
      }
      done++;
      progress();
    });
    progress(true);

    say('');
    say(
      table(
        [
          ['Imported', counts.imported.toLocaleString('en-US')],
          ['Already in Sadi Mail, skipped', counts.duplicate.toLocaleString('en-US')],
          ['Failed', counts.failed.toLocaleString('en-US')],
        ],
        [1],
      ),
    );
    if (failures.length) {
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      const file = deps.failureFile ?? `sadi-mail-import-failed-${stamp}.txt`;
      const lines = failures.map((f) => `${f.where}\t${f.reason}`);
      try {
        await writeFile(file, `Messages that could not be imported into ${address} (${base}).\nEach line: where the message is, a tab, and why.\n\n${lines.join('\n')}\n`);
        say('');
        say(`The ${plural(failures.length, 'message')} that failed are listed in ${file}`);
      } catch {
        say('');
        say('The messages that failed:');
      }
      for (const f of failures.slice(0, 10)) say(`  ${f.where}: ${f.reason}`);
      if (failures.length > 10) say(`  ...and ${failures.length - 10} more`);
      say('Running the same command again retries them; messages already in Sadi Mail are skipped.');
      return 1;
    }
    return 0;
  } catch (err) {
    return fail(err.message);
  } finally {
    await source.close();
  }
}
