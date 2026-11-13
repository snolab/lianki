/**
 * Mic recordings in the account (docs/recordings.md; owner tap card
 * 2026-11-14 ~03:35 JST, "批准：开始做"). While his mic is on in Lianki, each
 * finished utterance — active or passive, sent to the chat or not — is kept
 * with the transcript the mic already had, so he can review a day later and
 * download it to his Mac. app/api/my/recordings is the route; this is the
 * logic, without the request plumbing, so it is unit-tested.
 *
 *   POST {id, at, day, text, source, mode, device, speaker?, wav}   store one utterance   session only
 *   GET                       → {days: [{day, clips, ms, bytes}]}   newest first (?before=day, ?limit)
 *   GET ?day=D                → {day, clips: [{id, at, durationMs, …, text}]}   transcripts decrypted, no audio
 *   GET ?clip=ID              → the clip's WAV
 *   GET ?day=D&archive=zip    → the day as a zip: transcript.txt, transcript.json, one WAV per clip
 *   DELETE ?clip=ID | ?day=D  → delete it                         session only
 *
 * - **Own rows only.** Every statement carries the caller's user id; nothing
 *   in a request names an account.
 * - **Stored as sent.** The server never transcribes a recording (owner,
 *   2026-11-14 03:37 JST: transcription and any further processing run on his
 *   Mac): it keeps the audio and the text the mic already had.
 * - **At rest.** AES-256-GCM, key by HKDF-SHA256 from AUTH_SECRET with its own
 *   salt and info. The audio is sealed bytes in R2
 *   (`recordings/<uid>/<day>/<id>`), the transcript sealed in D1 `recording`;
 *   the AAD of each is user, kind and id.
 */
import type { D1Database } from "@cloudflare/workers-types";
import { seal, unseal } from "@/lib/connections/crypto";
import { type WavInfo, type WavLimits, fromBase64, parseWav } from "@/lib/voice-clone-ref";
import { type ZipEntry, ZIP_LIMITS, zipStream } from "@/lib/zip-stream";
import { objectKey } from "@/lib/recordings-sweep";

export { objectKey };

/**
 * Hard caps. Named constants, not config-store keys: they bound what the
 * Worker decrypts and holds in memory, so loosening one is a reviewed change.
 */
export const RECORDING_LIMITS = {
  /** One utterance's WAV (the mic cuts at 30 s, plus its pre-pad; 40 s at 16 kHz is 1,280,044 bytes). */
  maxBytes: 1_300_000,
  minMs: 100,
  maxMs: 40_000,
  /** The mic records at 16 kHz (mic.ts RATE). */
  sampleRates: [16_000],
  /** A transcript, in characters (UTF-16 units). */
  maxTextChars: 4_000,
  /** The device label. */
  maxDeviceChars: 40,
} as const satisfies WavLimits & Record<string, unknown>;

/** Clips one account may keep in one day; past it a POST is refused (429 day-full). */
export const MAX_CLIPS_PER_DAY = 5_000;
/** Days listed per GET, by default and at most. */
export const DAYS_PAGE = 30;
export const DAYS_PAGE_MAX = 100;
/** How far `at` may lie behind the server's clock (a queued upload retried later) and ahead of it. */
export const MAX_AGE_MS = 2 * 86_400_000;
export const MAX_SKEW_MS = 5 * 60_000;

const MAX_B64 = Math.ceil(RECORDING_LIMITS.maxBytes / 3) * 4;
/** A POST body's length at most: refused unread above it. */
export const MAX_POST_BODY = MAX_B64 + RECORDING_LIMITS.maxTextChars * 6 + 4_096;

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const ID_RE = /^[A-Za-z0-9_-]{16,32}$/;
const DEVICE_RE = /^[A-Za-z0-9._-]*$/;
// Control characters but tab and newlines: a transcript is plain text.
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
export const MODES = ["active", "passive"] as const;
export const SOURCES = ["local", "cloud", "none"] as const;
export const SPEAKERS = ["me", "other", "unknown"] as const;
export type Mode = (typeof MODES)[number];
export type Source = (typeof SOURCES)[number];
export type Speaker = (typeof SPEAKERS)[number];

const DAY_MS = 86_400_000;
/** A calendar day that exists ("2026-02-30" does not). */
export function isDay(s: unknown): s is string {
  if (typeof s !== "string" || !DAY_RE.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

export type RecordingPost = {
  id: string;
  at: number;
  day: string;
  text: string;
  source: Source;
  mode: Mode;
  device: string;
  speaker: Speaker | null;
  wav: Uint8Array;
  info: WavInfo;
};

const KEYS = ["id", "at", "day", "text", "source", "mode", "device", "speaker", "wav"];

/** A POST body: exactly these keys (speaker optional), each as described; anything else refused whole. */
export function parseRecordingPost(body: unknown, now: number): RecordingPost | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "bad body";
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some((k) => !KEYS.includes(k))) return "bad body";
  if (typeof b.id !== "string" || !ID_RE.test(b.id)) return "bad id";
  if (typeof b.at !== "number" || !Number.isSafeInteger(b.at)) return "bad at";
  if (b.at > now + MAX_SKEW_MS || b.at < now - MAX_AGE_MS) return "bad at";
  if (!isDay(b.day)) return "bad day";
  // The device's own date of `at`: within a day and a half of its UTC date (any zone).
  if (Math.abs(Date.parse(`${b.day}T12:00:00Z`) - b.at) > 1.5 * DAY_MS) return "bad day";
  if (typeof b.text !== "string") return "bad text";
  if (b.text.length > RECORDING_LIMITS.maxTextChars) return "text too long";
  if (CONTROL.test(b.text)) return "bad text";
  if (!(SOURCES as readonly unknown[]).includes(b.source)) return "bad source";
  if (!(MODES as readonly unknown[]).includes(b.mode)) return "bad mode";
  if (
    typeof b.device !== "string" ||
    b.device.length > RECORDING_LIMITS.maxDeviceChars ||
    !DEVICE_RE.test(b.device)
  )
    return "bad device";
  if (
    b.speaker !== undefined &&
    b.speaker !== null &&
    !(SPEAKERS as readonly unknown[]).includes(b.speaker)
  )
    return "bad speaker";
  if (typeof b.wav !== "string" || !b.wav) return "no wav";
  if (b.wav.length > MAX_B64) return "too large";
  const wav = fromBase64(b.wav);
  if (!wav) return "bad wav encoding";
  const info = parseWav(wav, RECORDING_LIMITS);
  if (typeof info === "string") return info;
  return {
    id: b.id,
    at: b.at,
    day: b.day,
    text: b.text,
    source: b.source as Source,
    mode: b.mode as Mode,
    device: b.device,
    speaker: (b.speaker as Speaker | undefined) ?? null,
    wav,
    info,
  };
}

// ---------------------------------------------------------------- at rest
export const RECORDINGS_KEY_SALT = "lianki/recordings";
export const RECORDINGS_KEY_INFO = "lianki/recordings/at-rest/v1";
const enc = new TextEncoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

/** The AES key for recordings at rest, derived from AUTH_SECRET (no new secret). */
export function recordingsKey(secret: string | undefined): Promise<CryptoKey> {
  if (!secret || secret.length < 32) throw new Error("recordings: AUTH_SECRET missing or short");
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
          salt: enc.encode(RECORDINGS_KEY_SALT),
          info: enc.encode(RECORDINGS_KEY_INFO),
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

export type Kind = "audio" | "text";
export const aadOf = (uid: string, kind: Kind, id: string) => `recording\0${uid}\0${kind}\0${id}`;
/** Sealed audio: this magic, a 12-byte IV, then ciphertext and tag. */
const MAGIC = enc.encode("LKR1");
export const MAX_SEALED_AUDIO = RECORDING_LIMITS.maxBytes + MAGIC.length + 12 + 16;
const MAX_SEALED_TEXT = RECORDING_LIMITS.maxTextChars * 6 + 128;

export async function sealAudio(key: CryptoKey, uid: string, id: string, wav: Uint8Array) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: enc.encode(aadOf(uid, "audio", id)) },
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

/** The WAV, or null for anything that does not open with this key, user and id. */
export async function openAudio(
  key: CryptoKey,
  uid: string,
  id: string,
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
          additionalData: enc.encode(aadOf(uid, "audio", id)),
        },
        key,
        sealed.slice(h),
      ),
    );
  } catch {
    return null;
  }
}

/** The transcript is sealed as a JSON string, so an empty one seals (and opens) like any other. */
export const sealText = (key: CryptoKey, uid: string, id: string, text: string) =>
  seal(key, JSON.stringify(text), aadOf(uid, "text", id));
export async function openText(
  key: CryptoKey,
  uid: string,
  id: string,
  sealed: string,
): Promise<string | null> {
  const s = await unseal(key, sealed, aadOf(uid, "text", id), MAX_SEALED_TEXT);
  if (s === null) return null;
  try {
    const t: unknown = JSON.parse(s);
    return typeof t === "string" ? t : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the store
export type ClipMeta = {
  id: string;
  day: string;
  at: number;
  durationMs: number;
  bytes: number;
  mode: Mode;
  source: Source;
  device: string;
  speaker: Speaker | null;
};
export type ClipRow = ClipMeta & { textSealed: string; createdAt: number };
export type DaySummary = { day: string; clips: number; ms: number; bytes: number };

export type RecDb = {
  /** Insert unless the id is already the account's; true when it was new. */
  insert(uid: string, r: ClipRow): Promise<boolean>;
  countDay(uid: string, day: string): Promise<number>;
  get(uid: string, id: string): Promise<ClipRow | null>;
  /** One day's clips, oldest first. */
  day(uid: string, day: string): Promise<ClipRow[]>;
  /** Days with clips, newest first, those before `before` when given. */
  days(uid: string, limit: number, before?: string): Promise<DaySummary[]>;
  deleteClip(uid: string, id: string): Promise<boolean>;
};
export type RecBlobs = {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
};
export type RecDeps = {
  uid: string;
  db: RecDb;
  blobs: RecBlobs;
  key: () => Promise<CryptoKey>;
  now?: number;
};
export type Out = { status: number; json: Record<string, unknown> };
/** Errors as kebab-case codes ("bad-day", "not-found"), as every API route answers. */
export const bad = (status: number, error: string): Out => ({
  status,
  json: { error: error.trim().replace(/\s+/g, "-") },
});
const metaOf = (r: ClipRow): ClipMeta => ({
  id: r.id,
  day: r.day,
  at: r.at,
  durationMs: r.durationMs,
  bytes: r.bytes,
  mode: r.mode,
  source: r.source,
  device: r.device,
  speaker: r.speaker,
});

export async function postRecording(d: RecDeps, body: unknown): Promise<Out> {
  const now = d.now ?? Date.now();
  const b = parseRecordingPost(body, now);
  if (typeof b === "string") return bad(b === "too large" ? 413 : 400, b);
  const have = await d.db.get(d.uid, b.id);
  if (have) return { status: 200, json: { ok: true, id: b.id, dup: true } };
  if ((await d.db.countDay(d.uid, b.day)) >= MAX_CLIPS_PER_DAY) return bad(429, "day full");
  const key = await d.key();
  const obj = objectKey(d.uid, b.day, b.id);
  // The audio first; then the row points at it. A row never points at nothing.
  await d.blobs.put(obj, await sealAudio(key, d.uid, b.id, b.wav));
  let fresh: boolean;
  try {
    fresh = await d.db.insert(d.uid, {
      id: b.id,
      day: b.day,
      at: b.at,
      durationMs: b.info.durationMs,
      bytes: b.info.bytes,
      mode: b.mode,
      source: b.source,
      device: b.device,
      speaker: b.speaker,
      textSealed: await sealText(key, d.uid, b.id, b.text),
      createdAt: now,
    });
  } catch (e) {
    await d.blobs.delete(obj).catch(() => {});
    throw e;
  }
  return { status: 200, json: { ok: true, id: b.id, ...(fresh ? {} : { dup: true }) } };
}

export async function listDays(d: RecDeps, q: URLSearchParams): Promise<Out> {
  const before = q.get("before");
  if (before !== null && !isDay(before)) return bad(400, "bad day");
  const raw = q.get("limit");
  const n = raw === null ? DAYS_PAGE : Number(raw);
  if (!Number.isInteger(n) || n < 1) return bad(400, "bad limit");
  const limit = Math.min(n, DAYS_PAGE_MAX);
  const days = await d.db.days(d.uid, limit, before ?? undefined);
  return { status: 200, json: { days, more: days.length === limit } };
}

export type DayClip = ClipMeta & { text: string | null };

/** A day's clips with their transcripts (null: does not open — rotated secret). */
export async function dayClips(d: RecDeps, day: string): Promise<DayClip[]> {
  const rows = await d.db.day(d.uid, day);
  const key = await d.key();
  const out: DayClip[] = [];
  for (const r of rows)
    out.push({ ...metaOf(r), text: await openText(key, d.uid, r.id, r.textSealed) });
  return out;
}

export async function getDay(d: RecDeps, day: string): Promise<Out> {
  if (!isDay(day)) return bad(400, "bad day");
  return { status: 200, json: { day, clips: await dayClips(d, day) } };
}

/** One clip's WAV, or why not. */
export async function clipAudio(
  d: RecDeps,
  id: string,
): Promise<{ wav: Uint8Array; meta: ClipMeta } | Out> {
  if (!ID_RE.test(id)) return bad(400, "bad id");
  const row = await d.db.get(d.uid, id);
  if (!row) return bad(404, "not found");
  const sealed = await d.blobs.get(objectKey(d.uid, row.day, row.id));
  const wav = sealed ? await openAudio(await d.key(), d.uid, row.id, sealed) : null;
  if (!wav) return bad(410, "unreadable");
  return { wav, meta: metaOf(row) };
}

/** A clip's file name in an archive and on the Mac: its local time of day and id. */
export const clipName = (c: Pick<ClipMeta, "at" | "id">, tzMin = 0) =>
  `${new Date(c.at - tzMin * 60_000).toISOString().slice(11, 19).replace(/:/g, "")}-${c.id}.wav`;

/** The transcript as text: one line per clip, "HH:MM:SS [speaker] text". */
export function transcriptTxt(clips: DayClip[], tzMin = 0): string {
  return (
    clips
      .map((c) => {
        const t = new Date(c.at - tzMin * 60_000).toISOString().slice(11, 19);
        const who = c.speaker ? ` [${c.speaker}]` : "";
        return `${t}${who} ${c.text ?? "(unreadable)"}`.trimEnd();
      })
      .join("\n") + "\n"
  );
}

/**
 * The day as a zip, streamed: transcript.txt and transcript.json first (the
 * transcripts are small), then each clip's WAV, read, opened and written one
 * at a time. `tzMin`: the viewer's offset (Date.getTimezoneOffset) for names.
 */
export async function dayArchive(
  d: RecDeps,
  day: string,
  tzMin = 0,
): Promise<ReadableStream<Uint8Array> | Out> {
  if (!isDay(day)) return bad(400, "bad day");
  if (!Number.isInteger(tzMin) || Math.abs(tzMin) > 14 * 60) return bad(400, "bad tz");
  const clips = await dayClips(d, day);
  if (!clips.length) return bad(404, "not found");
  const total = clips.reduce((s, c) => s + c.bytes + 200, 0);
  if (clips.length + 2 > ZIP_LIMITS.entries || total > ZIP_LIMITS.bytes)
    return bad(413, "too large");
  const key = await d.key();
  const at = new Date(Date.parse(`${day}T00:00:00Z`));
  const json = clips.map((c) => ({ ...c, file: clipName(c, tzMin) }));
  const uid = d.uid;
  const blobs = d.blobs;
  async function* entries(): AsyncGenerator<ZipEntry> {
    yield { name: "transcript.txt", data: enc.encode(transcriptTxt(clips, tzMin)), at };
    yield {
      name: "transcript.json",
      data: enc.encode(JSON.stringify({ day, clips: json }, null, 1)),
      at,
    };
    for (const c of clips) {
      const sealed = await blobs.get(objectKey(uid, day, c.id));
      const wav = sealed ? await openAudio(key, uid, c.id, sealed) : null;
      // A clip that does not open is left out; the transcript lists it.
      if (wav) yield { name: clipName(c, tzMin), data: wav, at: new Date(c.at) };
    }
  }
  return zipStream(entries());
}

export async function deleteClip(d: RecDeps, id: string): Promise<Out> {
  if (!ID_RE.test(id)) return bad(400, "bad id");
  const row = await d.db.get(d.uid, id);
  if (!row) return { status: 200, json: { ok: true, deleted: 0 } };
  await d.blobs.delete(objectKey(d.uid, row.day, id));
  await d.db.deleteClip(d.uid, id);
  return { status: 200, json: { ok: true, deleted: 1 } };
}

export async function deleteDay(d: RecDeps, day: string): Promise<Out> {
  if (!isDay(day)) return bad(400, "bad day");
  const rows = await d.db.day(d.uid, day);
  let deleted = 0;
  // Delete only this snapshot: uploads arriving meanwhile keep both row and audio.
  for (const row of rows) {
    await d.blobs.delete(objectKey(d.uid, day, row.id));
    if (await d.db.deleteClip(d.uid, row.id)) deleted++;
  }
  return { status: 200, json: { ok: true, deleted } };
}

// ---------------------------------------------------------------- D1 and R2
const COLS =
  "id, day, at, duration_ms AS durationMs, bytes, mode, source, device, speaker, text_sealed AS textSealed, created_at AS createdAt";

/** D1 statements for RecDb (db/migrations/0075_recording.sql). */
export function d1RecDb(db: D1Database): RecDb {
  return {
    async insert(uid, r) {
      const res = await db
        .prepare(
          "INSERT OR IGNORE INTO recording (user_id, id, day, at, duration_ms, bytes, mode, source, device, speaker, text_sealed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          uid,
          r.id,
          r.day,
          r.at,
          r.durationMs,
          r.bytes,
          r.mode,
          r.source,
          r.device,
          r.speaker,
          r.textSealed,
          r.createdAt,
        )
        .run();
      return (res.meta?.changes ?? 0) === 1;
    },
    async countDay(uid, day) {
      const r = await db
        .prepare("SELECT COUNT(*) AS n FROM recording WHERE user_id = ? AND day = ?")
        .bind(uid, day)
        .first<{ n: number }>();
      return Number(r?.n ?? 0);
    },
    async get(uid, id) {
      return db
        .prepare(`SELECT ${COLS} FROM recording WHERE user_id = ? AND id = ?`)
        .bind(uid, id)
        .first<ClipRow>();
    },
    async day(uid, day) {
      const r = await db
        .prepare(`SELECT ${COLS} FROM recording WHERE user_id = ? AND day = ? ORDER BY at, id`)
        .bind(uid, day)
        .all<ClipRow>();
      return r.results ?? [];
    },
    async days(uid, limit, before) {
      const r = await db
        .prepare(
          "SELECT day, COUNT(*) AS clips, SUM(duration_ms) AS ms, SUM(bytes) AS bytes FROM recording WHERE user_id = ? AND day < ? GROUP BY day ORDER BY day DESC LIMIT ?",
        )
        .bind(uid, before ?? "9999-12-31", limit)
        .all<DaySummary>();
      return (r.results ?? []).map((x) => ({
        day: x.day,
        clips: Number(x.clips),
        ms: Number(x.ms),
        bytes: Number(x.bytes),
      }));
    },
    async deleteClip(uid, id) {
      const r = await db
        .prepare("DELETE FROM recording WHERE user_id = ? AND id = ?")
        .bind(uid, id)
        .run();
      return (r.meta?.changes ?? 0) === 1;
    },
  };
}

/** The part of an R2 bucket RecBlobs uses. */
export type R2Like = {
  put(key: string, value: Uint8Array, o?: object): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(key: string): Promise<void>;
};
export function r2RecBlobs(bucket: R2Like): RecBlobs {
  return {
    async put(key, bytes) {
      await bucket.put(key, bytes, { httpMetadata: { contentType: "application/octet-stream" } });
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
