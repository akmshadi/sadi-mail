// A line-and-bytes reader over a TCP connection, shared by the SMTP and IMAP clients.
// The connection itself comes from a Dial, so tests can stand in a scripted server.

export type Security = 'tls' | 'starttls' | 'none';

export interface Wire {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  /** Upgrade a plain connection to TLS (STARTTLS). */
  startTls?(): Wire;
  close(): Promise<void>;
}

export type Dial = (host: string, port: number, security: Security) => Promise<Wire> | Wire;

const text = new TextEncoder();

export class Conn {
  private reader!: ReadableStreamDefaultReader<Uint8Array>;
  private writer!: WritableStreamDefaultWriter<Uint8Array>;
  private buf = new Uint8Array(0);

  constructor(private wire: Wire) {
    this.attach();
  }

  private attach(): void {
    this.reader = this.wire.readable.getReader();
    this.writer = this.wire.writable.getWriter();
  }

  private async fill(): Promise<void> {
    const { value, done } = await this.reader.read();
    if (done || !value) throw new Error('The server closed the connection.');
    const next = new Uint8Array(this.buf.length + value.length);
    next.set(this.buf);
    next.set(value, this.buf.length);
    this.buf = next;
  }

  /** One line, without its CRLF. */
  async line(): Promise<string> {
    for (;;) {
      const at = this.buf.indexOf(10);
      if (at >= 0) {
        const end = at > 0 && this.buf[at - 1] === 13 ? at - 1 : at;
        const out = new TextDecoder().decode(this.buf.subarray(0, end));
        this.buf = this.buf.subarray(at + 1);
        return out;
      }
      if (this.buf.length > 1024 * 1024) throw new Error('The server sent a line that is too long.');
      await this.fill();
    }
  }

  async bytes(count: number): Promise<Uint8Array> {
    while (this.buf.length < count) await this.fill();
    const out = this.buf.slice(0, count);
    this.buf = this.buf.subarray(count);
    return out;
  }

  async write(data: string | Uint8Array): Promise<void> {
    await this.writer.write(typeof data === 'string' ? text.encode(data) : data);
  }

  upgrade(): void {
    if (!this.wire.startTls) throw new Error('This connection cannot be upgraded to TLS.');
    this.reader.releaseLock();
    this.writer.releaseLock();
    this.wire = this.wire.startTls();
    this.buf = new Uint8Array(0);
    this.attach();
  }

  async close(): Promise<void> {
    try { this.reader.releaseLock(); this.writer.releaseLock(); } catch { /* already released */ }
    try { await this.wire.close(); } catch { /* already closed */ }
  }
}

/** Stop a conversation with a server that has gone quiet. */
export async function within<T>(ms: number, what: string, job: Promise<T>, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => { onTimeout(); reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)} seconds.`)); }, ms); });
  try { return await Promise.race([job, late]); } finally { clearTimeout(timer); }
}

export function b64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
export const b64text = (s: string) => b64(text.encode(s));
