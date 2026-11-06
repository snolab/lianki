/**
 * How the Worker's gate tells the app who a box token belongs to, without a
 * session and without a cookie: one request header, HMAC-signed with a key
 * derived from AUTH_SECRET, good for a minute. The gate strips it from every
 * incoming request; the signature is what protects a server with no gate in
 * front of it, such as `next dev`.
 */
export const BOX_IDENTITY_HEADER = "x-lk-box-identity";
const LABEL = "lianki-box-identity-v1:";
const TTL_MS = 60_000;

const enc = new TextEncoder();

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(`${LABEL}${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export type BoxIdentity = { userId: string; clientId: string };

export async function signBoxIdentity(
  secret: string,
  who: BoxIdentity,
  now = Date.now(),
): Promise<string> {
  // "." separates the parts, and encodeURIComponent leaves it alone.
  const part = (s: string) => encodeURIComponent(s).replace(/\./g, "%2E");
  const body = [part(who.userId), part(who.clientId), now + TTL_MS].join(".");
  return `${body}.${await hmacHex(secret, body)}`;
}

/** The identity, or null for anything unsigned, altered, expired or with no usable secret. */
export async function verifyBoxIdentity(
  secret: string | undefined,
  value: string | null | undefined,
  now = Date.now(),
): Promise<BoxIdentity | null> {
  if (!value || !secret || secret.length < 16 || value.length > 512) return null;
  const at = value.lastIndexOf(".");
  if (at < 0) return null;
  const body = value.slice(0, at);
  if (!sameHex(value.slice(at + 1), await hmacHex(secret, body))) return null;
  const [user, client, until] = body.split(".");
  if (!user || !client || !(Number(until) > now)) return null;
  try {
    return { userId: decodeURIComponent(user), clientId: decodeURIComponent(client) };
  } catch {
    return null;
  }
}
