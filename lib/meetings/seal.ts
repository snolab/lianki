/**
 * Meetings at rest (docs/meetings.md, "R2"): AES-256-GCM, the key by
 * HKDF-SHA256 from AUTH_SECRET with its own salt and info, so no new secret
 * and not the recordings key. Every seal binds where it belongs as AAD — user,
 * meeting, track and seq for a piece; user, meeting and kind for a text — so
 * a piece copied to another meeting, account or position does not open.
 *
 * Piece format: "LKM1" + 12-byte IV + ciphertext + 16-byte tag.
 * Text format: lib/connections/crypto.ts `seal` ("v1.<iv>.<ct>").
 */
import { seal, unseal } from "@/lib/connections/crypto";
import { MAX_CHUNK_BYTES, type Track } from "./core";

export const MEETINGS_KEY_SALT = "lianki/meetings";
export const MEETINGS_KEY_INFO = "lianki/meetings/at-rest/v1";
const enc = new TextEncoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

/** The AES key for meetings at rest, derived from AUTH_SECRET. */
export function meetingsKey(secret: string | undefined): Promise<CryptoKey> {
  if (!secret || secret.length < 32) throw new Error("meetings: AUTH_SECRET missing or short");
  let k = keyCache.get(secret);
  if (!k) {
    k = (async () => {
      const ikm = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, [
        "deriveKey",
      ]);
      return crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: enc.encode(MEETINGS_KEY_SALT),
          info: enc.encode(MEETINGS_KEY_INFO),
        },
        ikm,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    })();
    keyCache.set(secret, k);
  }
  return k;
}

export const chunkAad = (uid: string, id: string, track: Track, seq: number) =>
  `meeting\0${uid}\0${id}\0${track}\0${seq}`;
export const titleAad = (uid: string, id: string) => `meeting\0${uid}\0${id}\0title`;
export const lineAad = (uid: string, id: string, track: string, startMs: number) =>
  `meeting\0${uid}\0${id}\0line\0${track}\0${startMs}`;

const MAGIC = enc.encode("LKM1");
const HEAD = MAGIC.length + 12;
export const SEAL_OVERHEAD = HEAD + 16;

export async function sealChunk(
  key: CryptoKey,
  uid: string,
  id: string,
  track: Track,
  seq: number,
  bytes: Uint8Array,
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: enc.encode(chunkAad(uid, id, track, seq)) },
      key,
      bytes as Uint8Array<ArrayBuffer>,
    ),
  );
  const out = new Uint8Array(HEAD + ct.length);
  out.set(MAGIC, 0);
  out.set(iv, MAGIC.length);
  out.set(ct, HEAD);
  return out;
}

/** The plain piece, or null for anything that does not open as this user, meeting, track and seq. */
export async function openChunk(
  key: CryptoKey,
  uid: string,
  id: string,
  track: Track,
  seq: number,
  sealed: Uint8Array,
): Promise<Uint8Array | null> {
  if (sealed.length < SEAL_OVERHEAD + 1 || sealed.length > MAX_CHUNK_BYTES + SEAL_OVERHEAD)
    return null;
  if (MAGIC.some((x, i) => sealed[i] !== x)) return null;
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: sealed.slice(MAGIC.length, HEAD),
          additionalData: enc.encode(chunkAad(uid, id, track, seq)),
        },
        key,
        sealed.slice(HEAD),
      ),
    );
  } catch {
    return null;
  }
}

/** A text sealed as a JSON string, so "" seals and opens like any other. */
export const sealText = (key: CryptoKey, text: string, aad: string) =>
  seal(key, JSON.stringify(text), aad);
export async function openText(
  key: CryptoKey,
  sealed: string,
  aad: string,
  maxLen = 32_768,
): Promise<string | null> {
  const s = await unseal(key, sealed, aad, maxLen);
  if (s === null) return null;
  try {
    const t: unknown = JSON.parse(s);
    return typeof t === "string" ? t : null;
  } catch {
    return null;
  }
}
