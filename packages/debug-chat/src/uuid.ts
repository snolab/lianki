/**
 * A random UUIDv4 from crypto.getRandomValues. crypto.randomUUID exists only
 * in a secure context, and the pill's Li frame on a plain http:// site is not
 * one (a frame is secure only when every ancestor is), so ids minted there
 * must not depend on it. getRandomValues works in every context.
 */
export function uuidv4(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
