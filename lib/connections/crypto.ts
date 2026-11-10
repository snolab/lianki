// Sealing for connection secrets (docs/connections.md, "Tokens at rest").
//
// AES-256-GCM with a key derived by HKDF-SHA256 from AUTH_SECRET, so no new
// Worker secret is needed and AUTH_SECRET itself never leaves the Worker. Each
// use has its own HKDF `info`, so the key that seals refresh tokens in D1 is
// not the one that seals the OAuth state cookie. Every seal binds its context
// as AAD (the row's user and provider, or the cookie's user), so a sealed
// value copied into another row or another user's cookie does not open.
//
// Format: "v1.<iv base64url>.<ciphertext+tag base64url>". Rotating
// AUTH_SECRET makes every sealed value unreadable: connections then read as
// "reconnect needed", nothing is lost but the grant.

import { base64url } from "@/lib/cli-login";

export type SealPurpose = "google-refresh" | "google-oauth-state";

const enc = new TextEncoder();
const dec = new TextDecoder();
const VERSION = "v1";

function fromBase64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

const keyCache = new Map<string, Promise<CryptoKey>>();

/** The AES key for one purpose, derived from `secret` (AUTH_SECRET). */
export function sealKey(purpose: SealPurpose, secret: string | undefined): Promise<CryptoKey> {
  if (!secret || secret.length < 32) throw new Error("connections: AUTH_SECRET missing or short");
  const id = `${purpose}\0${secret}`;
  let k = keyCache.get(id);
  if (!k) {
    k = (async () => {
      const ikm = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, [
        "deriveKey",
      ]);
      return crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: enc.encode("lianki/connections"),
          info: enc.encode(`lianki/connections/${purpose}/${VERSION}`),
        },
        ikm,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    })();
    keyCache.set(id, k);
  }
  return k;
}

export async function seal(key: CryptoKey, plain: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(aad) },
    key,
    enc.encode(plain),
  );
  return `${VERSION}.${base64url(iv)}.${base64url(new Uint8Array(ct))}`;
}

/** The plain text, or null for anything that does not open with this key and AAD. */
export async function unseal(
  key: CryptoKey,
  sealed: string,
  aad: string,
  /** The longest sealed value accepted (a voiceprint is larger than a token). */
  maxLen = 16_384,
): Promise<string | null> {
  if (typeof sealed !== "string" || sealed.length > maxLen) return null;
  const [v, ivS, ctS, ...rest] = sealed.split(".");
  if (v !== VERSION || rest.length || !ivS || !ctS) return null;
  const iv = fromBase64url(ivS);
  const ct = fromBase64url(ctS);
  if (!iv || iv.length !== 12 || !ct || ct.length < 17) return null;
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as Uint8Array<ArrayBuffer>, additionalData: enc.encode(aad) },
      key,
      ct as Uint8Array<ArrayBuffer>,
    );
    return dec.decode(pt);
  } catch {
    return null;
  }
}
