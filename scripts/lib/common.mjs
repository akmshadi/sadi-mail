// Shared helpers for scripts/dev.mjs and scripts/setup.mjs. Node built-ins only.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const WRANGLER_CONFIG = join(ROOT, 'wrangler.jsonc');
export const DEV_VARS = join(ROOT, '.dev.vars');

export const newSecretKey = () => randomBytes(32).toString('base64');

export function nodeOk(min = 22) {
  const major = Number(process.versions.node.split('.')[0]);
  return { ok: major >= min, version: process.versions.node };
}

// Prefer the wrangler installed in node_modules; fall back to npx.
export function wranglerCommand() {
  const local = join(ROOT, 'node_modules', '.bin', 'wrangler');
  return existsSync(local) ? { cmd: local, pre: [] } : { cmd: 'npx', pre: ['wrangler'] };
}

export function runWrangler(args, { input, inherit = false } = {}) {
  const { cmd, pre } = wranglerCommand();
  const r = spawnSync(cmd, [...pre, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', WRANGLER_SEND_METRICS: process.env.WRANGLER_SEND_METRICS ?? 'false' },
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

export function runPnpmBuild() {
  return spawnSync('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'inherit' }).status ?? 1;
}

export async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    let answered = false;
    rl.question(question, (a) => { answered = true; rl.close(); resolve(a.trim()); });
    rl.on('close', () => { if (!answered) resolve(''); });
  });
}

// Pull the first JSON array/object out of text that may have banner lines around it.
export function parseJsonLoose(text) {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
  if (start < 0 || end < start) return undefined;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return undefined; }
}

export function tail(text, lines = 6) {
  return text.trim().split('\n').slice(-lines).map((l) => `     ${l}`).join('\n');
}

export const NOT_LOGGED_IN = /not authenticated|not logged in|not signed in|run `?wrangler login/i;
