#!/usr/bin/env node
// `pnpm dev`: zero-question local start. Extra arguments go to `wrangler dev`,
// for example `pnpm dev --port 8791`.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { DEV_VARS, ROOT, WRANGLER_CONFIG, NOT_LOGGED_IN, newSecretKey, nodeOk, runPnpmBuild, runWrangler, wranglerCommand } from './lib/common.mjs';
import { hasBinding } from './lib/jsonc.mjs';

const say = (m) => console.log(`sadi-mail dev: ${m}`);
const die = (m) => { console.error(`sadi-mail dev: ${m}`); process.exit(1); };

const node = nodeOk(22);
if (!node.ok) die(`Node 22 or newer is needed, and this is ${node.version}. Install Node 22 from nodejs.org and try again.`);
if (!existsSync(`${ROOT}/node_modules`)) die('dependencies are not installed. Run `pnpm install` first.');

// 1. .dev.vars with a random MAIL_SECRET_KEY. An existing value is never touched or printed.
const KEY_LINE = /^[ \t]*MAIL_SECRET_KEY[ \t]*=[ \t]*(.*)$/m;
if (!existsSync(DEV_VARS)) {
  writeFileSync(DEV_VARS, `MAIL_SECRET_KEY=${newSecretKey()}\n`, { mode: 0o600 });
  say('created .dev.vars with a new random MAIL_SECRET_KEY.');
} else {
  const current = readFileSync(DEV_VARS, 'utf8');
  const m = KEY_LINE.exec(current);
  if (!m) {
    appendFileSync(DEV_VARS, `${current.length && !current.endsWith('\n') ? '\n' : ''}MAIL_SECRET_KEY=${newSecretKey()}\n`);
    say('added a random MAIL_SECRET_KEY to your existing .dev.vars.');
  } else if (m[1].replace(/^["']|["']$/g, '').trim() === '') {
    writeFileSync(DEV_VARS, current.replace(KEY_LINE, () => `MAIL_SECRET_KEY=${newSecretKey()}`));
    say('filled the empty MAIL_SECRET_KEY in .dev.vars.');
  }
}

// 2. Workers AI needs a Cloudflare login even locally. Say so plainly instead of failing obscurely.
if (hasBinding(readFileSync(WRANGLER_CONFIG, 'utf8'), 'ai')) {
  const who = runWrangler(['whoami']);
  if (who.status !== 0 || NOT_LOGGED_IN.test(who.stdout + who.stderr)) {
    die('AI needs a Cloudflare login. Run `npx wrangler login`, or switch AI off by commenting out the "ai" line in wrangler.jsonc.');
  }
}

// 3. Local database, client build, then the dev server.
say('applying local database migrations.');
const mig = runWrangler(['d1', 'migrations', 'apply', 'sadi-mail', '--local'], { inherit: true });
if (mig.status !== 0) die('the local database migrations failed. The messages above say why.');

say('building the client.');
if (runPnpmBuild() !== 0) die('the client build failed. The messages above say why.');

say('starting wrangler dev (default address http://localhost:8787).');
const { cmd, pre } = wranglerCommand();
const child = spawn(cmd, [...pre, 'dev', ...process.argv.slice(2)], { cwd: ROOT, stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 0 : 1)));
