import { env } from 'cloudflare:test';
import { api } from '../src/worker/api';
import { receive } from '../src/worker/ingest';
import type { Env } from '../src/worker/util';

export interface Draft {
  from: string;
  to: string;
  subject: string;
  body?: string;
  html?: string;
  messageId?: string;
  inReplyTo?: string;
  auth?: string;
  attachment?: { filename: string; content: string };
}

/** Tests never reach a real model: the Workers AI binding is removed unless a test supplies a stand-in. */
export const offline: Env = { ...env, AI: undefined };

let counter = 0;

/** Build a small RFC 5322 message. */
export function eml(d: Draft): string {
  const id = d.messageId ?? `test-${++counter}-${Date.now()}@sender.example`;
  const head = [
    ...(d.auth ? [`Authentication-Results: mx.cloudflare.net; ${d.auth}`] : []),
    `From: ${d.from}`,
    `To: ${d.to}`,
    `Subject: ${d.subject}`,
    `Message-ID: <${id}>`,
    `Date: ${new Date().toUTCString()}`,
    ...(d.inReplyTo ? [`In-Reply-To: <${d.inReplyTo}>`, `References: <${d.inReplyTo}>`] : []),
    'MIME-Version: 1.0',
  ];
  if (d.attachment) {
    const b = 'sadi-mail-boundary';
    return [
      ...head,
      `Content-Type: multipart/mixed; boundary="${b}"`,
      '',
      `--${b}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      d.body ?? '',
      `--${b}`,
      `Content-Type: application/pdf; name="${d.attachment.filename}"`,
      `Content-Disposition: attachment; filename="${d.attachment.filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      btoa(d.attachment.content),
      `--${b}--`,
      '',
    ].join('\r\n');
  }
  if (d.html) return [...head, 'Content-Type: text/html; charset=utf-8', '', d.html].join('\r\n');
  return [...head, 'Content-Type: text/plain; charset=utf-8', '', d.body ?? ''].join('\r\n');
}

const addressOf = (value: string) => /<([^>]+)>/.exec(value)?.[1] ?? value;

export async function deliver(d: Draft, using: Env = offline) {
  return receive(using, { bytes: new TextEncoder().encode(eml(d)).buffer as ArrayBuffer, envelopeFrom: addressOf(d.from), envelopeTo: addressOf(d.to) });
}

/** Call the API as the local development owner. */
export async function call<T>(path: string, init?: RequestInit & { env?: Env }): Promise<{ status: number; body: T }> {
  const response = await api.fetch(new Request(`http://localhost${path}`, init), init?.env ?? offline, { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext);
  return { status: response.status, body: (await response.json()) as T };
}

export const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
