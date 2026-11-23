#!/usr/bin/env node
// `pnpm run setup`: put Sadi Mail on your own Cloudflare account. Safe to run again.
//   --dry-run         print every command and file change; run nothing, not even read-only calls
//   --yes             do not ask before creating things (the sign-in refusal still applies)
//   --team-domain X   answer the Access team domain question (for use with --yes)
//   --aud X           answer the Access application AUD question (for use with --yes)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ROOT, WRANGLER_CONFIG, NOT_LOGGED_IN, ask, newSecretKey, nodeOk, parseJsonLoose, runPnpmBuild, runWrangler, tail } from './lib/common.mjs';
import { PLACEHOLDER_ID, getDatabaseId, getVar, setDatabaseId, setVar } from './lib/jsonc.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const DRY = flag('--dry-run');
const YES = flag('--yes');
const DB_NAME = 'sadi-mail';
const BUCKET = 'sadi-mail';
const SECRET = 'MAIL_SECRET_KEY';

const done = [];
const out = (m = '') => console.log(m);
const line = (m) => console.log(`   ${m}`);
const step = (n, title) => out(`\n${n}. ${title}`);
const wouldRun = (cmd) => line(`would run: ${cmd}`);
const wouldWrite = (m) => line(`would change wrangler.jsonc: ${m}`);

function fail(reason) {
  console.error(`\nSetup stopped: ${reason}`);
  console.error(done.length ? `Already done: ${done.join('; ')}.` : 'Nothing has been changed yet.');
  console.error('Running `pnpm run setup` again is safe; it picks up where this left off.');
  process.exit(1);
}

// Run wrangler; fail with a plain reason when it does not succeed (unless `soft`).
function wr(args, { input, soft = false, what } = {}) {
  const r = runWrangler(args, { input });
  if (r.error) fail(`could not start wrangler (${r.error.message}). Run \`pnpm install\` and try again.`);
  if (r.status !== 0 && !soft) {
    const text = r.stdout + r.stderr;
    const hint = /more than one account/i.test(text) ? ' You have more than one Cloudflare account: set CLOUDFLARE_ACCOUNT_ID to the one you want and run again.' : '';
    console.error(tail(text, 8));
    fail(`${what ?? `wrangler ${args.slice(0, 2).join(' ')}`} failed.${hint}`);
  }
  return r;
}

async function confirm(question) {
  if (YES || DRY) return true;
  if (!process.stdin.isTTY) fail('this needs a yes or no from you and there is no terminal. Run it in a terminal, or pass --yes.');
  const a = (await ask(`   ${question} [Y/n] `)).toLowerCase();
  if (a === '' || a === 'y' || a === 'yes') return true;
  fail('you chose not to continue.');
}

const readConfig = () => readFileSync(WRANGLER_CONFIG, 'utf8');
const writeConfig = (text) => writeFileSync(WRANGLER_CONFIG, text);

out(DRY ? 'Sadi Mail setup (dry run: nothing is run, nothing is changed)' : 'Sadi Mail setup');

// ---------------------------------------------------------------- 1. Node and login
step(1, 'Checking Node and your Cloudflare login');
const node = nodeOk(22);
if (!node.ok) fail(`Node 22 or newer is needed and this is ${node.version}. Install Node 22 from nodejs.org.`);
line(`Node ${node.version}: ok`);
if (!existsSync(WRANGLER_CONFIG)) fail('wrangler.jsonc was not found. Run this from the Sadi Mail folder.');
if (DRY) {
  wouldRun('npx wrangler whoami');
} else {
  if (!existsSync(`${ROOT}/node_modules`)) fail('dependencies are not installed. Run `pnpm install` first.');
  const who = runWrangler(['whoami']);
  if (who.status !== 0 || NOT_LOGGED_IN.test(who.stdout + who.stderr)) {
    fail('you are not logged in to Cloudflare. Run `npx wrangler login`, then run setup again.');
  }
  line('Cloudflare login: ok');
}

// ---------------------------------------------------------------- 2. D1
step(2, `Database "${DB_NAME}" (Cloudflare D1)`);
let dbId;
if (DRY) {
  wouldRun('npx wrangler d1 list --json');
  wouldRun(`npx wrangler d1 create ${DB_NAME}   (only if "${DB_NAME}" is not in the list)`);
  wouldWrite(`set "database_id" to the real id, replacing ${PLACEHOLDER_ID}`);
} else {
  const findDb = () => {
    const list = parseJsonLoose(wr(['d1', 'list', '--json'], { what: 'listing your databases' }).stdout);
    const hit = Array.isArray(list) ? list.find((d) => d.name === DB_NAME) : undefined;
    return hit?.uuid ?? hit?.database_id ?? hit?.id;
  };
  dbId = findDb();
  if (dbId) {
    line(`found existing database "${DB_NAME}" (${dbId})`);
  } else {
    line(`"${DB_NAME}" does not exist on this account yet. It will be created (free, empty).`);
    await confirm('Create it?');
    wr(['d1', 'create', DB_NAME], { what: `creating the database "${DB_NAME}"` });
    dbId = findDb();
    if (!dbId) fail(`the database "${DB_NAME}" was created but its id could not be read. Run setup again.`);
    done.push(`created database "${DB_NAME}"`);
    line(`created database "${DB_NAME}" (${dbId})`);
  }
  const text = readConfig();
  if (getDatabaseId(text) === dbId) {
    line('wrangler.jsonc already has this id');
  } else {
    await confirm('Write this database id into wrangler.jsonc?');
    writeConfig(setDatabaseId(text, dbId));
    done.push('wrote the database id into wrangler.jsonc');
    line('wrote the database id into wrangler.jsonc');
  }
}

// ---------------------------------------------------------------- 3. R2
step(3, `Mail storage bucket "${BUCKET}" (Cloudflare R2)`);
if (DRY) {
  wouldRun('npx wrangler r2 bucket list');
  wouldRun(`npx wrangler r2 bucket create ${BUCKET}   (only if it is not in the list)`);
} else {
  const hasBucket = () => new RegExp(`(^|[^\\w-])${BUCKET}([^\\w-]|$)`, 'm').test(wr(['r2', 'bucket', 'list'], { what: 'listing your R2 buckets' }).stdout);
  if (hasBucket()) {
    line(`found existing bucket "${BUCKET}"`);
  } else {
    line(`"${BUCKET}" does not exist yet. It will be created. R2 must be switched on for your account (dashboard › R2); the free tier is enough to start.`);
    await confirm('Create it?');
    wr(['r2', 'bucket', 'create', BUCKET], { what: `creating the bucket "${BUCKET}"` });
    done.push(`created bucket "${BUCKET}"`);
    line(`created bucket "${BUCKET}"`);
  }
}

// ---------------------------------------------------------------- 4. migrations
step(4, 'Database tables (migrations)');
if (DRY) {
  wouldRun(`npx wrangler d1 migrations apply ${DB_NAME} --remote`);
  line('applies only the migrations not yet applied; running it again does nothing');
} else {
  line('applying any migrations the remote database does not have yet');
  await confirm('Apply them?');
  wr(['d1', 'migrations', 'apply', DB_NAME, '--remote'], { what: 'applying migrations' });
  done.push('applied migrations');
  line('migrations are up to date');
}

// ---------------------------------------------------------------- 5. secret
step(5, `Encryption secret ${SECRET}`);
let secretDeferred = false;
const putSecret = () => {
  wr(['secret', 'put', SECRET], { input: `${newSecretKey()}\n`, what: `setting ${SECRET}` });
  done.push(`set ${SECRET}`);
  line(`set ${SECRET} (a random 32-byte value; it was not printed and is not stored anywhere else)`);
};
if (DRY) {
  wouldRun('npx wrangler secret list');
  wouldRun(`npx wrangler secret put ${SECRET}   (only if not set; a random 32-byte base64 value is piped on stdin, never shown)`);
} else {
  const list = runWrangler(['secret', 'list']);
  const names = list.status === 0 ? parseJsonLoose(list.stdout) : undefined;
  if (Array.isArray(names) && names.some((s) => s.name === SECRET)) {
    line(`${SECRET} is already set; leaving it alone`);
  } else if (list.status !== 0) {
    secretDeferred = true;
    line('the Worker does not exist yet, so the secret will be set right after the first deploy (step 7)');
  } else {
    line(`${SECRET} is not set. A random value will be generated and sent straight to Cloudflare.`);
    line('Losing it makes saved AI keys unreadable, so do not rotate it casually.');
    await confirm('Set it?');
    putSecret();
  }
}

// ---------------------------------------------------------------- 6. sign-in
step(6, 'Sign-in (Cloudflare Access)');
line('Sadi Mail has no passwords of its own. Cloudflare Access in front of the Worker decides who gets in.');
line('Create it in the dashboard: Zero Trust › Access › Applications › Add an application › Self-hosted,');
line('point it at your Worker address, and add a policy that allows your email. The team domain looks like');
line('yourname.cloudflareaccess.com; the AUD is the "Application Audience (AUD) Tag" on the application.');
line('No address to protect yet? Leave both blank: Sadi Mail deploys locked (nobody can sign in), and you re-run setup later.');
if (DRY) {
  wouldWrite('"AUTH_MODE" to "access"');
  wouldWrite('"ACCESS_TEAM_DOMAIN" to the team domain you type (or keep the current one)');
  wouldWrite('"ACCESS_AUD" to the AUD you type (or keep the current one)');
  line('would refuse to deploy if "AUTH_MODE" were still "dev": anyone on the internet could then open the mailbox');
} else {
  let text = readConfig();
  let team = opt('--team-domain') ?? getVar(text, 'ACCESS_TEAM_DOMAIN') ?? '';
  let aud = opt('--aud') ?? getVar(text, 'ACCESS_AUD') ?? '';
  const interactive = !YES && process.stdin.isTTY;
  if (interactive) {
    const t = await ask(`   Team domain${team ? ` [${team}]` : ' (blank to skip)'}: `);
    if (t) team = t;
    const a = await ask(`   Application AUD${aud ? ' [keep current]' : ' (blank to skip)'}: `);
    if (a) aud = a;
  }
  team = team.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!team || !aud) line('Team domain or AUD is blank: Sadi Mail will deploy locked until you run setup again with both.');
  text = setVar(setVar(setVar(text, 'AUTH_MODE', 'access'), 'ACCESS_TEAM_DOMAIN', team), 'ACCESS_AUD', aud);
  if (text !== readConfig()) {
    await confirm('Write AUTH_MODE "access" and these values into wrangler.jsonc?');
    writeConfig(text);
    done.push('set sign-in to Cloudflare Access in wrangler.jsonc');
  }
  line(`AUTH_MODE is "access"; team domain ${team || '(blank)'}; AUD ${aud ? 'set' : '(blank)'}`);
}

// ---------------------------------------------------------------- 7. deploy
step(7, 'Build and deploy');
if (DRY) {
  line('would check wrangler.jsonc still says AUTH_MODE "access" (never deploys with "dev")');
  wouldRun('npx vite build');
  wouldRun('npx wrangler deploy');
  wouldRun(`npx wrangler secret put ${SECRET}   (right after the deploy, only if step 5 found no Worker yet)`);
} else {
  if (getVar(readConfig(), 'AUTH_MODE') !== 'access') {
    fail('AUTH_MODE is not "access" in wrangler.jsonc, and Sadi Mail will not deploy that way: in "dev" mode anyone on the internet could open the mailbox. Set it to "access" and run setup again.');
  }
  line('Sadi Mail will be uploaded to your Cloudflare account as the Worker "sadi-mail".');
  await confirm('Deploy?');
  if (runPnpmBuild() !== 0) fail('the client build failed. The messages above say why.');
  const dep = wr(['deploy'], { what: 'wrangler deploy' });
  done.push('deployed the Worker "sadi-mail"');
  const url = /https:\/\/[^\s]+\.workers\.dev/.exec(dep.stdout + dep.stderr)?.[0];
  line(`deployed${url ? `: ${url}` : ''}`);
  if (secretDeferred) putSecret();
}

// ---------------------------------------------------------------- 8. checklist
step(8, DRY ? 'What is left for you to do by hand (printed after a real run too)' : 'Done. What is left for you to do by hand');
out(`
   [ ] Sign-in: if you left the team domain or AUD blank, create the Access application for your Worker
       address, then run \`pnpm run setup\` again and enter both. Until then nobody can sign in.

   [ ] Receive mail: Cloudflare dashboard › your domain › Email › Email Routing › Routing rules.
       Add a custom address, or the catch-all, with the action "Send to a Worker" and the Worker "sadi-mail".
       Email Routing needs Cloudflare's MX records on that domain, so the domain cannot also receive
       mail at another provider. This script never changes DNS.

   [ ] Send real mail later (optional): Sadi Mail stores sent mail and sends nothing until you turn this on.
       Needs the Workers Paid plan and a sending domain onboarded under Email Sending. Then in
       wrangler.jsonc set "SEND_MODE" to "cloudflare", add
         "send_email": [{ "name": "EMAIL" }]
       and run \`pnpm run setup\` again to deploy.

   [ ] AI (optional): Workers AI is the "ai" binding in wrangler.jsonc and is already there. It is
       billed to your account by use. To turn it off, comment out that "ai" line and deploy again.`);
if (DRY) out('\nDry run finished. Nothing was run and no file was changed.');
