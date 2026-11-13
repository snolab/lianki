/**
 * The voice-clone reference in the account (docs/voice-clone.md; owner tap
 * card 2026-11-14 02:50 JST, "批准：存到我的账号"). One short recording of the
 * account holder's own voice and its transcript, the reference a voice-clone
 * TTS (F5-TTS) speaks from, so his own voice can be synthesized for his
 * account only. app/api/my/voice-clone-ref is the route; this is the logic,
 * without the request plumbing, so it is unit-tested.
 *
 *   GET                         → {ref: null | {durationMs, sampleRate, bytes, createdAt, updatedAt}}
 *   GET ?audio=1                → the same with {text, wav (base64)}, decrypted   the session only
 *   PUT {ticket, text, wav}     → store or replace   a fresh `clone-ref-put` passkey ticket
 *   DELETE {ticket}             → delete it          a fresh `clone-ref-delete` passkey ticket
 *
 * Unlike the voiceprint (features only), this is AUDIO of a voice, so:
 * - **Own row only.** Every statement is by the session's user id; nothing in
 *   a request names an account; a ticket approved for another account is
 *   refused (`uid`).
 * - **Fresh passkey for every write.** The ticket is a voiceprint ticket
 *   (lib/voiceprint-ticket.ts, aud lianki-voiceprint, Ed25519 STT_TICKET_KEY)
 *   with its own ops, `uv: true`, 60 s, device "*", spent once here
 *   (`verification`, `voice-clone-ref:<jti>`). The passkey window's grant
 *   never mints these ops (FRESH_PASSKEY_OPS), and their assertion opens none.
 * - **Exactly one WAV.** RIFF/WAVE, PCM 16-bit, mono, an allowed sample rate,
 *   only `fmt `, `LIST` and `data` chunks, sizes that add up exactly, length
 *   and duration inside CLONE_REF_LIMITS; the body is exactly {ticket, text,
 *   wav}. Anything else is refused whole.
 * - **At rest.** AES-256-GCM, key by HKDF-SHA256 from AUTH_SECRET with its own
 *   salt and info (not the voiceprint's, not the Google tokens'). The audio is
 *   sealed bytes in R2 (`voice-clone-ref/<uid>/<rev>`: too large for a D1 row
 *   once sealed); the transcript is sealed in D1 `voice_clone_ref`. The AAD of
 *   each is user, kind and rev, so neither opens in another account, as the
 *   other kind, or with another revision's half. Rotating AUTH_SECRET leaves
 *   it unreadable (`unreadable: true`; upload again from the Mac).
 */
import type { D1Database } from "@cloudflare/workers-types";
import { seal, unseal } from "@/lib/connections/crypto";
import { checkCloudTicket } from "@/lib/voiceprint-cloud";
import { type VoiceprintOp, randomId } from "@/lib/voiceprint-ticket";

/**
 * Hard caps on what may be stored. Named constants, not config-store keys:
 * they bound what the Worker decrypts and holds in memory, so loosening one is
 * a reviewed code change, never a live switch.
 */
export const CLONE_REF_LIMITS = {
  /** The WAV file's length at most (30 s at 24 kHz, 16-bit mono is 1,440,044 bytes). */
  maxBytes: 1_500_000,
  /** Its duration, at least and at most. */
  minMs: 1_000,
  maxMs: 30_000,
  /** Sample rates accepted (F5-TTS works at 24 kHz). */
  sampleRates: [24_000] as readonly number[],
  /** The transcript, in characters (UTF-16 units). */
  maxTextChars: 2_000,
} as const;

/** The base64 text of the largest WAV accepted. */
const MAX_B64 = Math.ceil(CLONE_REF_LIMITS.maxBytes / 3) * 4;
/** A PUT body's length at most (the wav's base64, the text JSON-escaped, the ticket): refused unread above it. */
export const MAX_PUT_BODY = MAX_B64 + CLONE_REF_LIMITS.maxTextChars * 6 + 4_096;

export type WavInfo = { sampleRate: number; durationMs: number; bytes: number };

const u32 = (b: Uint8Array, o: number) =>
  (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const tag = (b: Uint8Array, o: number) =>
  String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
const ALLOWED_CHUNKS = ["fmt ", "LIST", "data"];

/** A WAV exactly as accepted, or why not. Reads only the header and chunk table. */
export function parseWav(b: Uint8Array): WavInfo | string {
  const L = CLONE_REF_LIMITS;
  if (b.length > L.maxBytes) return "too large";
  if (b.length < 44) return "not a wav";
  if (tag(b, 0) !== "RIFF" || tag(b, 8) !== "WAVE") return "not a wav";
  if (u32(b, 4) + 8 !== b.length) return "bad riff size";
  let fmt: { rate: number } | null = null;
  let dataBytes = -1;
  const seen = new Set<string>();
  let o = 12;
  while (o < b.length) {
    if (o + 8 > b.length) return "truncated chunk";
    const id = tag(b, o);
    const size = u32(b, o + 4);
    if (!ALLOWED_CHUNKS.includes(id)) return "unexpected chunk";
    if (seen.has(id)) return "duplicate chunk";
    seen.add(id);
    const body = o + 8;
    const end = body + size + (size & 1);
    if (end > b.length) return "truncated chunk";
    if (id === "fmt ") {
      if (size !== 16 && !(size === 18 && u16(b, body + 16) === 0)) return "bad fmt";
      const format = u16(b, body);
      const channels = u16(b, body + 2);
      const rate = u32(b, body + 4);
      const byteRate = u32(b, body + 8);
      const align = u16(b, body + 12);
      const bits = u16(b, body + 14);
      if (format !== 1) return "not pcm";
      if (channels !== 1) return "not mono";
      if (bits !== 16) return "not 16-bit";
      if (!L.sampleRates.includes(rate)) return "bad sample rate";
      if (align !== 2 || byteRate !== rate * 2) return "bad fmt";
      fmt = { rate };
    } else if (id === "data") {
      if (!fmt) return "data before fmt";
      if (size === 0 || size & 1) return "bad data";
      dataBytes = size;
    }
    o = end;
  }
  if (!fmt || dataBytes < 0) return "no audio";
  const durationMs = Math.round((dataBytes / 2 / fmt.rate) * 1000);
  if (durationMs < L.minMs) return "too short";
  if (durationMs > L.maxMs) return "too long";
  return { sampleRate: fmt.rate, durationMs, bytes: b.length };
}

// ---------------------------------------------------------------- base64
export function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromBase64(s: string): Uint8Array | null {
  if (s.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the body
// Control characters but tab and newlines: a transcript is plain text.
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export type CloneRefPut = { ticket: string; text: string; wav: Uint8Array; info: WavInfo };

/** A PUT body: exactly {ticket, text, wav}, the wav a valid reference. */
export function parseCloneRefPut(body: unknown): CloneRefPut | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "bad body";
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some((k) => k !== "ticket" && k !== "text" && k !== "wav")) return "bad body";
  if (typeof b.ticket !== "string") return "no ticket";
  if (typeof b.text !== "string" || !b.text.trim()) return "no text";
  if (b.text.length > CLONE_REF_LIMITS.maxTextChars) return "text too long";
  if (CONTROL.test(b.text)) return "bad text";
  if (typeof b.wav !== "string" || !b.wav) return "no wav";
  if (b.wav.length > MAX_B64) return "too large";
  const wav = fromBase64(b.wav);
  if (!wav) return "bad wav encoding";
  const info = parseWav(wav);
  if (typeof info === "string") return info;
  return { ticket: b.ticket, text: b.text, wav, info };
}

// ---------------------------------------------------------------- at rest
export const CLONE_REF_KEY_SALT = "lianki/voice-clone-ref";
export const CLONE_REF_KEY_INFO = "lianki/voice-clone-ref/at-rest/v1";
const enc = new TextEncoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

/** The AES key for the reference at rest, derived from AUTH_SECRET (no new secret). */
export function cloneRefKey(secret: string | undefined): Promise<CryptoKey> {
  if (!secret || secret.length < 32)
    throw new Error("voice-clone-ref: AUTH_SECRET missing or short");
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
          salt: enc.encode(CLONE_REF_KEY_SALT),
          info: enc.encode(CLONE_REF_KEY_INFO),
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

export type RefKind = "audio" | "text";
export const aadOf = (uid: string, kind: RefKind, rev: string) =>
  `voice-clone-ref\0${uid}\0${kind}\0${rev}`;
/** Sealed audio: this magic, a 12-byte IV, then ciphertext and tag. */
const MAGIC = enc.encode("LKC1");
/** The sealed audio's length at most: the WAV cap plus magic, IV and tag. */
export const MAX_SEALED_AUDIO = CLONE_REF_LIMITS.maxBytes + MAGIC.length + 12 + 16;
/** The sealed transcript's length at most (UTF-8 up to 3 bytes a UTF-16 unit, base64). */
const MAX_SEALED_TEXT = CLONE_REF_LIMITS.maxTextChars * 4 + 64;

export async function sealAudio(
  key: CryptoKey,
  uid: string,
  rev: string,
  wav: Uint8Array,
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: enc.encode(aadOf(uid, "audio", rev)) },
      key,
      wav as Uint8Array<ArrayBuffer>,
    ),
  );
  const out = new Uint8Array(MAGIC.length + 12 + ct.length);
  out.set(MAGIC, 0);
  out.set(iv, MAGIC.length);
  out.set(ct, MAGIC.length + 12);
  return out;
}

/** The WAV, or null for anything that does not open with this key, user and rev. */
export async function openAudio(
  key: CryptoKey,
  uid: string,
  rev: string,
  sealed: Uint8Array,
): Promise<Uint8Array | null> {
  const h = MAGIC.length + 12;
  if (sealed.length > MAX_SEALED_AUDIO || sealed.length < h + 17) return null;
  if (MAGIC.some((x, i) => sealed[i] !== x)) return null;
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: sealed.slice(MAGIC.length, h),
          additionalData: enc.encode(aadOf(uid, "audio", rev)),
        },
        key,
        sealed.slice(h),
      ),
    );
  } catch {
    return null;
  }
}

export const sealText = (key: CryptoKey, uid: string, rev: string, text: string) =>
  seal(key, text, aadOf(uid, "text", rev));
export const openText = (key: CryptoKey, uid: string, rev: string, sealed: string) =>
  unseal(key, sealed, aadOf(uid, "text", rev), MAX_SEALED_TEXT);

/** The R2 object of one revision of an account's reference. */
export const objectKey = (uid: string, rev: string) => `voice-clone-ref/${uid}/${rev}`;

// ---------------------------------------------------------------- the store
export type RefMeta = {
  durationMs: number;
  sampleRate: number;
  bytes: number;
  createdAt: string;
  updatedAt: string;
};
export type RefRow = RefMeta & { rev: string; textSealed: string };

export type CloneRefDb = {
  get(uid: string): Promise<RefRow | null>;
  /** Insert or replace the account's row (created_at kept on replace). */
  put(uid: string, row: RefRow): Promise<void>;
  /** Delete the account's row; true when there was one. */
  delete(uid: string): Promise<boolean>;
  /** Spend a ticket's jti (atomic, once): true the first time. */
  spend(jti: string, exp: number): Promise<boolean>;
};
export type CloneRefBlobs = {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
};
export type CloneRefDeps = {
  uid: string;
  db: CloneRefDb;
  blobs: CloneRefBlobs;
  key: () => Promise<CryptoKey>;
  pub: () => Promise<CryptoKey>;
  now?: number;
};
type Out = { status: number; json: Record<string, unknown> };
/** Errors as kebab-case codes ("not-mono", "wrong-op"), as every API route answers. */
const bad = (status: number, error: string): Out => ({
  status,
  json: { error: error.trim().replace(/\s+/g, "-") },
});
const metaOf = (r: RefRow): RefMeta => ({
  durationMs: r.durationMs,
  sampleRate: r.sampleRate,
  bytes: r.bytes,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

export async function getCloneRef(d: CloneRefDeps, withAudio: boolean): Promise<Out> {
  const row = await d.db.get(d.uid);
  if (!row) return { status: 200, json: { ref: null } };
  const meta = metaOf(row);
  if (!withAudio) return { status: 200, json: { ref: meta } };
  const key = await d.key();
  const sealed = await d.blobs.get(objectKey(d.uid, row.rev));
  const wav = sealed ? await openAudio(key, d.uid, row.rev, sealed) : null;
  const text = await openText(key, d.uid, row.rev, row.textSealed);
  if (!wav || text === null) return { status: 200, json: { ref: { ...meta, unreadable: true } } };
  return { status: 200, json: { ref: { ...meta, text, wav: toBase64(wav) } } };
}

const spendTicket = async (d: CloneRefDeps, ticket: string, op: VoiceprintOp) => {
  const t = await checkCloudTicket(ticket, await d.pub(), {
    op,
    uid: d.uid,
    devices: ["*"],
    now: d.now,
  });
  if ("error" in t) return t;
  if (!(await d.db.spend(t.jti, t.exp))) return { error: "approval already used" };
  return t;
};

export async function putCloneRef(d: CloneRefDeps, body: unknown): Promise<Out> {
  const b = parseCloneRefPut(body);
  if (typeof b === "string") return bad(b === "too large" ? 413 : 400, b);
  const t = await spendTicket(d, b.ticket, "clone-ref-put");
  if ("error" in t) return bad(401, t.error);
  const key = await d.key();
  const rev = randomId(12);
  const at = new Date(d.now ?? Date.now()).toISOString();
  const prev = await d.db.get(d.uid);
  const newKey = objectKey(d.uid, rev);
  // The audio first, under a fresh name; then the row points at it; then the old one goes.
  await d.blobs.put(newKey, await sealAudio(key, d.uid, rev, b.wav));
  try {
    await d.db.put(d.uid, {
      rev,
      textSealed: await sealText(key, d.uid, rev, b.text),
      durationMs: b.info.durationMs,
      sampleRate: b.info.sampleRate,
      bytes: b.info.bytes,
      createdAt: prev?.createdAt ?? at,
      updatedAt: at,
    });
  } catch (e) {
    await d.blobs.delete(newKey).catch(() => {});
    throw e;
  }
  if (prev && prev.rev !== rev) await d.blobs.delete(objectKey(d.uid, prev.rev)).catch(() => {});
  return {
    status: 200,
    json: {
      ok: true,
      ref: {
        durationMs: b.info.durationMs,
        sampleRate: b.info.sampleRate,
        bytes: b.info.bytes,
        createdAt: prev?.createdAt ?? at,
        updatedAt: at,
      },
    },
  };
}

export async function deleteCloneRef(d: CloneRefDeps, body: unknown): Promise<Out> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad(400, "bad body");
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some((k) => k !== "ticket")) return bad(400, "bad body");
  if (typeof b.ticket !== "string") return bad(400, "no ticket");
  const t = await spendTicket(d, b.ticket, "clone-ref-delete");
  if ("error" in t) return bad(401, t.error);
  const row = await d.db.get(d.uid);
  if (!row) return { status: 200, json: { ok: true, deleted: 0 } };
  await d.db.delete(d.uid);
  await d.blobs.delete(objectKey(d.uid, row.rev));
  return { status: 200, json: { ok: true, deleted: 1 } };
}

// ---------------------------------------------------------------- D1 and R2
/** D1 statements for CloneRefDb (db/migrations/0074_voice_clone_ref.sql). */
export function d1CloneRefDb(db: D1Database): CloneRefDb {
  return {
    async get(uid) {
      return db
        .prepare(
          "SELECT rev, text_sealed AS textSealed, duration_ms AS durationMs, sample_rate AS sampleRate, bytes, created_at AS createdAt, updated_at AS updatedAt FROM voice_clone_ref WHERE user_id = ?",
        )
        .bind(uid)
        .first<RefRow>();
    },
    async put(uid, r) {
      await db
        .prepare(
          "INSERT INTO voice_clone_ref (user_id, rev, text_sealed, duration_ms, sample_rate, bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT (user_id) DO UPDATE SET rev = excluded.rev, text_sealed = excluded.text_sealed, duration_ms = excluded.duration_ms, sample_rate = excluded.sample_rate, bytes = excluded.bytes, updated_at = excluded.updated_at",
        )
        .bind(
          uid,
          r.rev,
          r.textSealed,
          r.durationMs,
          r.sampleRate,
          r.bytes,
          r.createdAt,
          r.updatedAt,
        )
        .run();
    },
    async delete(uid) {
      const r = await db.prepare("DELETE FROM voice_clone_ref WHERE user_id = ?").bind(uid).run();
      return (r.meta?.changes ?? 0) === 1;
    },
    async spend(jti, exp) {
      const now = new Date().toISOString();
      const r = await db
        .prepare(
          "INSERT OR IGNORE INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(
          `voice-clone-ref:${jti}`,
          "voice-clone-ref",
          "used",
          new Date(exp * 1000 + 60_000).toISOString(),
          now,
          now,
        )
        .run();
      return (r.meta?.changes ?? 0) === 1;
    },
  };
}

/** The part of an R2 bucket CloneRefBlobs uses. */
export type R2Like = {
  put(key: string, value: Uint8Array, o?: object): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(key: string): Promise<void>;
};
export function r2CloneRefBlobs(bucket: R2Like): CloneRefBlobs {
  return {
    async put(key, bytes) {
      await bucket.put(key, bytes, {
        httpMetadata: { contentType: "application/octet-stream" },
      });
    },
    async get(key) {
      const o = await bucket.get(key);
      return o ? new Uint8Array(await o.arrayBuffer()) : null;
    },
    async delete(key) {
      await bucket.delete(key);
    },
  };
}
