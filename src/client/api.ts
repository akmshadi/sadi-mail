import type { ApiError } from '../shared/types';

// A host application hands Sadi Mail a signed token in the URL fragment. It is kept in memory only.
let hostToken: string | null = null;
const fromHash = /[#&]token=([^&]+)/.exec(window.location.hash);
if (fromHash) {
  hostToken = decodeURIComponent(fromHash[1]!);
  history.replaceState(null, '', window.location.pathname + window.location.search);
}

export function setHostToken(token: string | null): void {
  hostToken = token;
}

export class RequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (hostToken) headers.authorization = `Bearer ${hostToken}`;
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new RequestError(0, 'offline', 'Could not reach the server. Check your connection and try again.');
  }
  const data = (await response.json().catch(() => null)) as T | ApiError | null;
  if (!response.ok) {
    const err = data as ApiError | null;
    throw new RequestError(response.status, err?.error ?? 'error', err?.message ?? `Request failed (${response.status}).`);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
  /** POST and read the answer as it arrives. `onText` is called with everything received so far. */
  async stream(path: string, body: unknown, onText: (soFar: string) => void): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(hostToken ? { authorization: `Bearer ${hostToken}` } : {}) }, body: JSON.stringify(body) });
    } catch {
      throw new RequestError(0, 'offline', 'Could not reach the server. Check your connection and try again.');
    }
    if (!response.ok || !response.body) {
      const err = (await response.json().catch(() => null)) as ApiError | null;
      throw new RequestError(response.status, err?.error ?? 'error', err?.message ?? `Request failed (${response.status}).`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      onText(text);
    }
    return text.trim();
  },
  async putBlob<T = unknown>(path: string, blob: Blob, extra: Record<string, string> = {}): Promise<T> {
    const response = await fetch(`/api${path}`, { method: 'PUT', headers: { ...extra, 'content-type': blob.type || 'application/octet-stream', ...(hostToken ? { authorization: `Bearer ${hostToken}` } : {}) }, body: blob });
    const data = (await response.json().catch(() => null)) as T | ApiError | null;
    if (!response.ok) throw new RequestError(response.status, (data as ApiError | null)?.error ?? 'error', (data as ApiError | null)?.message ?? 'Upload failed.');
    return data as T;
  },
  /** Attachment and raw-source links need the token too, so they are fetched and saved from memory. */
  async download(path: string, filename: string): Promise<void> {
    const response = await fetch(`/api${path}`, { headers: hostToken ? { authorization: `Bearer ${hostToken}` } : {} });
    if (!response.ok) throw new RequestError(response.status, 'error', 'Could not download the file.');
    const url = URL.createObjectURL(await response.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },
};
