/** Bytes, hex and SHA-256 over Web Crypto (browser, Worker, bun alike). */

export type Bytes = Uint8Array;

const HEX = /^(?:[0-9a-f]{2})*$/;

export function toHex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** Lower-case, even-length hex only; anything else throws. */
export function fromHex(h: string): Bytes {
  if (typeof h !== "string" || !HEX.test(h)) throw new Error("lian: not lower-case hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function utf8(s: string): Bytes {
  return new TextEncoder().encode(s);
}

export function equalBytes(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export async function sha256(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
}

/** A 32-byte hash as hex: exactly 64 lower-case hex characters. */
export function isHash(h: unknown): h is string {
  return typeof h === "string" && /^[0-9a-f]{64}$/.test(h);
}
