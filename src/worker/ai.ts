import { HttpError } from './auth';
import { type Env, newId } from './util';

export type ProviderKind = 'workers-ai' | 'anthropic' | 'openai' | 'openai-compatible';

export interface ProviderRow {
  id: string;
  kind: ProviderKind;
  name: string;
  base_url: string | null;
  model: string;
  key_cipher: string | null;
  key_last4: string | null;
  priority: number;
  enabled: number;
}

export interface Completion {
  text: string;
  provider: string;
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
  ms: number;
}

export interface Ask {
  system: string;
  user: string;
  maxTokens?: number;
}

/** Sensible starting models. Each is editable; none is baked into the calling code. */
export const DEFAULT_MODELS: Record<ProviderKind, string> = {
  // Chosen on a real test (2026-11-23): correct Bangla and cleaner summaries than glm-4.7-flash, at a lower output price.
  'workers-ai': '@cf/google/gemma-4-26b-a4b-it',
  anthropic: 'claude-haiku-5-5',
  openai: 'gpt-6-luna',
  'openai-compatible': '',
};

// ---------- key storage ----------

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function secretKey(env: Env): Promise<CryptoKey> {
  if (!env.MAIL_SECRET_KEY) {
    throw new HttpError(409, 'no_secret_key', 'This installation has no MAIL_SECRET_KEY, so it cannot store a provider key. Set that secret, then add the key again.');
  }
  let raw: Uint8Array;
  try {
    raw = unb64(env.MAIL_SECRET_KEY);
  } catch {
    raw = new Uint8Array();
  }
  if (raw.byteLength !== 32) throw new HttpError(409, 'bad_secret_key', 'MAIL_SECRET_KEY must be 32 random bytes, base64 encoded.');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function sealKey(env: Env, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await secretKey(env), new TextEncoder().encode(plain));
  return `${b64(iv)}.${b64(new Uint8Array(cipher))}`;
}

export async function openKey(env: Env, sealed: string): Promise<string> {
  const [iv, cipher] = sealed.split('.');
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv ?? '') }, await secretKey(env), unb64(cipher ?? ''));
    return new TextDecoder().decode(plain);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new Error('The stored key could not be read. MAIL_SECRET_KEY may have changed; add the key again.');
  }
}

// ---------- providers ----------

/**
 * Providers in the order Sadi Mail tries them. Workers AI is always first when its binding is on:
 * mail then never leaves Cloudflare. Other providers come after it, in their own priority order.
 */
export async function activeProviders(env: Env): Promise<ProviderRow[]> {
  const rows = (await env.DB.prepare('SELECT id, kind, name, base_url, model, key_cipher, key_last4, priority, enabled FROM ai_provider WHERE enabled = 1 ORDER BY priority, created_at').all<ProviderRow>()).results;
  const usable = rows.filter((r) => (r.kind === 'workers-ai' ? !!env.AI : !!r.key_cipher));
  if (env.AI && !rows.some((r) => r.kind === 'workers-ai')) {
    usable.unshift({ id: 'builtin-workers-ai', kind: 'workers-ai', name: 'Cloudflare Workers AI', base_url: null, model: DEFAULT_MODELS['workers-ai'], key_cipher: null, key_last4: null, priority: 0, enabled: 1 });
  }
  return usable.sort((a, b) => a.priority - b.priority);
}

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(45_000) });
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const detail = (data?.error as { message?: string } | undefined)?.message ?? `HTTP ${response.status}`;
    throw new Error(String(detail).slice(0, 300));
  }
  return data ?? {};
}

type Raw = { text: string; tokensIn: number | null; tokensOut: number | null };
const num = (v: unknown) => (typeof v === 'number' ? v : null);

async function callProvider(env: Env, p: ProviderRow, ask: Ask): Promise<Raw> {
  const maxTokens = ask.maxTokens ?? 900;
  const messages = [{ role: 'system', content: ask.system }, { role: 'user', content: ask.user }];

  if (p.kind === 'workers-ai') {
    if (!env.AI) throw new Error('The Workers AI binding is not switched on.');
    // Workers AI models answer in one of two shapes depending on the model family.
    const read = (out: Record<string, unknown>): Raw => {
      const choice = (out.choices as { message?: { content?: string | null } }[] | undefined)?.[0]?.message?.content;
      const text = typeof out.response === 'string' ? out.response : typeof choice === 'string' ? choice : out.response ? JSON.stringify(out.response) : '';
      const usage = (out.usage ?? {}) as Record<string, unknown>;
      return { text, tokensIn: num(usage.prompt_tokens), tokensOut: num(usage.completion_tokens) };
    };
    // Some Workers AI models think before answering and can spend the whole allowance doing it,
    // returning nothing. Mail tasks do not need that, so thinking is switched off. A model that does
    // not accept the switch, or still answers empty, gets one more try with room to think.
    try {
      const first = read((await env.AI.run(p.model, { messages, max_completion_tokens: maxTokens, chat_template_kwargs: { enable_thinking: false } })) as Record<string, unknown>);
      if (first.text.trim()) return first;
    } catch {
      // Fall through to the plain call.
    }
    const out = (await env.AI.run(p.model, { messages, max_completion_tokens: maxTokens + 3000, max_tokens: maxTokens + 3000 })) as Record<string, unknown>;
    const second = read(out);
    if (!second.text.trim()) console.warn(JSON.stringify({ at: 'ai.workers-ai.empty', model: p.model, keys: Object.keys(out) }));
    return second;
  }

  const key = await openKey(env, p.key_cipher ?? '');

  if (p.kind === 'anthropic') {
    const out = await post('https://api.anthropic.com/v1/messages', { 'x-api-key': key, 'anthropic-version': '2026-10-21' }, {
      model: p.model, max_tokens: maxTokens, system: ask.system, messages: [{ role: 'user', content: ask.user }],
    });
    const text = ((out.content as { type: string; text?: string }[] | undefined) ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
    const usage = (out.usage ?? {}) as Record<string, unknown>;
    return { text, tokensIn: num(usage.input_tokens), tokensOut: num(usage.output_tokens) };
  }

  if (p.kind === 'openai') {
    const out = await post('https://api.openai.com/v1/responses', { authorization: `Bearer ${key}` }, { model: p.model, instructions: ask.system, input: ask.user, max_output_tokens: maxTokens });
    // The text is not guaranteed to be the first output item, so collect every output_text part.
    const text = ((out.output as { type: string; content?: { type: string; text?: string }[] }[] | undefined) ?? [])
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content ?? [])
      .filter((part) => part.type === 'output_text')
      .map((part) => part.text ?? '')
      .join('');
    const usage = (out.usage ?? {}) as Record<string, unknown>;
    return { text, tokensIn: num(usage.input_tokens), tokensOut: num(usage.output_tokens) };
  }

  // Any service that speaks the OpenAI Chat Completions format at its own address.
  const base = (p.base_url ?? '').replace(/\/+$/, '');
  if (!/^https:\/\//i.test(base)) throw new Error('This provider needs an https:// base address.');
  const out = await post(`${base}/chat/completions`, { authorization: `Bearer ${key}` }, { model: p.model, messages, max_tokens: maxTokens });
  const text = (out.choices as { message?: { content?: string } }[] | undefined)?.[0]?.message?.content ?? '';
  const usage = (out.usage ?? {}) as Record<string, unknown>;
  return { text, tokensIn: num(usage.prompt_tokens), tokensOut: num(usage.completion_tokens) };
}

export async function callsToday(env: Env, now: number = Date.now()): Promise<number> {
  const start = Math.floor(now / 86_400_000) * 86_400_000;
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM agent_run WHERE at >= ? AND status != 'skipped'").bind(start).first<{ n: number }>())?.n ?? 0;
}

/**
 * Ask the first provider that answers. A provider that fails is skipped and the next one is tried,
 * so an outage at one vendor does not stop the assistant.
 */
export async function complete(env: Env, ask: Ask, only?: ProviderRow): Promise<Completion> {
  const providers = only ? [only] : await activeProviders(env);
  if (providers.length === 0) throw new HttpError(409, 'ai_not_connected', 'No AI provider is connected. An owner or admin can add one in Settings.');
  const limit = Number(env.AI_DAILY_LIMIT) || 500;
  if ((await callsToday(env)) >= limit) throw new HttpError(409, 'ai_daily_limit', `The daily limit of ${limit} AI calls has been reached. It resets at 00:00 UTC.`);

  let last = '';
  for (const p of providers) {
    const t0 = Date.now();
    try {
      const raw = await callProvider(env, p, ask);
      if (!raw.text.trim()) throw new Error('The model returned an empty answer.');
      return { text: raw.text.trim(), provider: p.name, model: p.model, tokensIn: raw.tokensIn, tokensOut: raw.tokensOut, ms: Date.now() - t0 };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      last = `${p.name}: ${err instanceof Error ? err.message : String(err)}`;
      console.warn(JSON.stringify({ at: 'ai.provider', provider: p.name, error: last }));
    }
  }
  throw new HttpError(409, 'ai_failed', `The AI provider did not answer. ${last}`);
}

/** Pull one JSON object out of a model answer, whatever it is wrapped in. */
export function readJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface RunLog {
  agentId?: string | null;
  kind: string;
  threadId?: string | null;
  userId?: string | null;
  status: 'ok' | 'failed' | 'skipped';
  completion?: Completion;
  output?: string;
  error?: string;
}

export async function logRun(env: Env, run: RunLog): Promise<string> {
  const id = newId();
  await env.DB.prepare(
    'INSERT INTO agent_run (id, agent_id, kind, thread_id, user_id, at, status, ms, provider, model, tokens_in, tokens_out, output, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(
    id, run.agentId ?? null, run.kind, run.threadId ?? null, run.userId ?? null, Date.now(), run.status, run.completion?.ms ?? null, run.completion?.provider ?? null,
    run.completion?.model ?? null, run.completion?.tokensIn ?? null, run.completion?.tokensOut ?? null, run.output ?? null, run.error ?? null,
  ).run();
  return id;
}

/** Text deltas from one Server-Sent-Events chunk of a Workers AI stream (either answer shape). */
function deltasOf(line: string): string {
  if (!line.startsWith('data:')) return '';
  const data = line.slice(5).trim();
  if (!data || data === '[DONE]') return '';
  try {
    const j = JSON.parse(data) as { response?: unknown; choices?: { delta?: { content?: unknown } }[] };
    const a = typeof j.response === 'string' ? j.response : '';
    const b = j.choices?.[0]?.delta?.content;
    return a || (typeof b === 'string' ? b : '');
  } catch {
    return '';
  }
}

/**
 * Like complete(), but the answer arrives as it is written. Workers AI streams word by word; any
 * other provider is asked in the ordinary way and its whole answer is delivered at once, so the
 * caller reads one kind of stream either way. `done` resolves with the full text once it has ended.
 */
export async function completeStream(env: Env, ask: Ask): Promise<{ stream: ReadableStream<Uint8Array>; done: Promise<Completion> }> {
  const providers = await activeProviders(env);
  if (providers.length === 0) throw new HttpError(409, 'ai_not_connected', 'No AI provider is connected. An owner or admin can add one in Settings.');
  const limit = Number(env.AI_DAILY_LIMIT) || 500;
  if ((await callsToday(env)) >= limit) throw new HttpError(409, 'ai_daily_limit', `The daily limit of ${limit} AI calls has been reached. It resets at 00:00 UTC.`);

  const encoder = new TextEncoder();
  const first = providers[0]!;
  let finish!: (c: Completion) => void;
  let fail!: (e: unknown) => void;
  const done = new Promise<Completion>((resolve, reject) => { finish = resolve; fail = reject; });
  done.catch(() => undefined);
  const t0 = Date.now();

  const whole = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
    const c = await complete(env, ask);
    controller.enqueue(encoder.encode(c.text));
    finish(c);
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        if (first.kind !== 'workers-ai' || !env.AI) {
          await whole(controller);
        } else {
          const maxTokens = ask.maxTokens ?? 900;
          const source = (await env.AI.run(first.model, {
            messages: [{ role: 'system', content: ask.system }, { role: 'user', content: ask.user }],
            stream: true, max_completion_tokens: maxTokens, chat_template_kwargs: { enable_thinking: false },
          })) as ReadableStream<Uint8Array>;
          const reader = source.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let text = '';
          for (;;) {
            const { value, done: ended } = await reader.read();
            if (ended) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
              const piece = deltasOf(line.trim());
              if (piece) { text += piece; controller.enqueue(encoder.encode(piece)); }
            }
          }
          const tail = deltasOf(buffer.trim());
          if (tail) { text += tail; controller.enqueue(encoder.encode(tail)); }
          // A model that streamed nothing (some spend the allowance thinking) gets the ordinary call instead.
          if (!text.trim()) await whole(controller);
          else finish({ text: text.trim(), provider: first.name, model: first.model, tokensIn: null, tokensOut: null, ms: Date.now() - t0 });
        }
        controller.close();
      } catch (err) {
        fail(err);
        controller.error(err);
      }
    },
  });
  return { stream, done };
}
