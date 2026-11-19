/**
 * Meetings in the account, the server's logic (docs/meetings.md), without
 * the request plumbing (app/api/my/meetings/** is that), so it is unit-tested.
 *
 *   POST   /api/my/meetings                         {tap:true, …} → the new meeting   createMeeting
 *   GET    /api/my/meetings[?before=C&limit=N]      the list, newest first           listMeetings
 *   GET    /api/my/meetings/<id>                    one meeting + its pieces          getMeeting
 *   PATCH  /api/my/meetings/<id>                    {title?, transcript?}            patchMeeting
 *   DELETE /api/my/meetings/<id>                    gone for the user at once        deleteMeeting
 *   POST   /api/my/meetings/<id>/end                {interrupted?, durationMs?}      endMeeting
 *   PUT    /api/my/meetings/<id>/chunks/<t>/<seq>   raw bytes + x-lk-* headers       putChunk
 *   GET    /api/my/meetings/<id>/chunks/<t>/<seq>   one piece, opened                chunkBytes
 *   GET    /api/my/meetings/<id>/download[?part=txt|vtt]  the video / transcript     downloadAv, transcriptFile
 *   PUT    /api/my/meetings/<id>/lines              [line, …]                        putLines
 *   GET    /api/my/meetings/<id>/lines              the lines                        getLines
 *
 * - **Own rows only.** Every statement carries the caller's user id; nothing
 *   in a request names an account.
 * - **R2 first, then the row**; a failed row deletes the object again.
 * - A meeting being deleted (`deleting`) is gone from every read at once.
 */
import type { D1Database } from "@cloudflare/workers-types";
import {
  AUDIO_TRACKS,
  type AudioTrack,
  type ChunkHeaders,
  type ChunkMeta,
  LEFTOVER_MS,
  LIST_PAGE,
  LIST_PAGE_MAX,
  MAX_CHUNK_BYTES,
  MAX_DEVICE_CHARS,
  MAX_SEQ,
  MAX_TITLE_CHARS,
  MEETING_ID_RE,
  type MeetingStatus,
  TRANSCRIPTS,
  type TranscriptChoice,
  type TranscriptStatus,
  type Track,
  chunkKey,
  extOf,
  isAudioTrack,
  isTrack,
  isMimeOk,
  newMeetingId,
  sha256Hex,
} from "./core";
import { lineAad, openChunk, openText, sealChunk, sealText, titleAad } from "./seal";
import { type PurgeBlobs, purgeMeeting } from "./sweep";

export type Out = { status: number; json: Record<string, unknown> };
/** Errors as kebab-case codes, as every API route answers. */
export const bad = (status: number, error: string): Out => ({
  status,
  json: { error: error.trim().replace(/\s+/g, "-") },
});

export type MeetBlobs = PurgeBlobs & {
  put(key: string, bytes: Uint8Array): Promise<unknown>;
  get(key: string): Promise<Uint8Array | null>;
};
export type MeetLimits = { quotaBytes: number; maxMs: number; chunkMs: number };
export type MeetDeps = {
  uid: string;
  db: D1Database;
  blobs: MeetBlobs;
  key: () => Promise<CryptoKey>;
  limits: MeetLimits;
  now?: number;
};

type Row = {
  id: string;
  titleSealed: string;
  status: MeetingStatus;
  startedAt: number;
  endedAt: number | null;
  lastChunkAt: number | null;
  durationMs: number;
  bytes: number;
  mimeAv: string;
  mimeAudio: string;
  width: number | null;
  height: number | null;
  hasMic: number;
  hasRoomAudio: number;
  device: string;
  transcript: TranscriptChoice;
  transcriptStatus: TranscriptStatus;
};
const COLS =
  "id, title_sealed AS titleSealed, status, started_at AS startedAt, ended_at AS endedAt, last_chunk_at AS lastChunkAt, duration_ms AS durationMs, bytes, mime_av AS mimeAv, mime_audio AS mimeAudio, width, height, has_mic AS hasMic, has_room_audio AS hasRoomAudio, device, transcript, transcript_status AS transcriptStatus";

export type MeetingView = Omit<Row, "titleSealed" | "hasMic" | "hasRoomAudio" | "lastChunkAt"> & {
  title: string | null;
  hasMic: boolean;
  hasRoomAudio: boolean;
};

async function view(d: MeetDeps, r: Row): Promise<MeetingView> {
  const { titleSealed, hasMic, hasRoomAudio, lastChunkAt: _l, ...rest } = r;
  return {
    ...rest,
    title: await openText(await d.key(), titleSealed, titleAad(d.uid, r.id)),
    hasMic: Boolean(hasMic),
    hasRoomAudio: Boolean(hasRoomAudio),
  };
}

async function row(d: MeetDeps, id: string): Promise<Row | null> {
  return d.db
    .prepare(`SELECT ${COLS} FROM meeting WHERE user_id = ? AND id = ? AND status != 'deleting'`)
    .bind(d.uid, id)
    .first<Row>();
}

/** The account's stored bytes (every meeting but those being deleted). */
export async function usedBytes(d: MeetDeps): Promise<number> {
  const r = await d.db
    .prepare(
      "SELECT COALESCE(SUM(bytes), 0) AS n FROM meeting WHERE user_id = ? AND status != 'deleting'",
    )
    .bind(d.uid)
    .first<{ n: number }>();
  return Number(r?.n ?? 0);
}

const isObj = (b: unknown): b is Record<string, unknown> =>
  Boolean(b) && typeof b === "object" && !Array.isArray(b);
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const cleanTitle = (t: unknown): string | null =>
  typeof t === "string" && t.trim() && t.length <= MAX_TITLE_CHARS && !CONTROL.test(t)
    ? t.trim()
    : null;
const dim = (v: unknown) =>
  v === undefined || v === null
    ? null
    : Number.isInteger(v) && (v as number) > 0 && (v as number) <= 16_384
      ? (v as number)
      : NaN;

const CREATE_KEYS = [
  "tap",
  "title",
  "mimeAv",
  "mimeAudio",
  "width",
  "height",
  "hasMic",
  "hasRoomAudio",
  "device",
  "transcript",
];

/** A new meeting, `recording`. Only on a tap (the client sends `tap: true` from a trusted click). */
export async function createMeeting(d: MeetDeps, body: unknown): Promise<Out> {
  const now = d.now ?? Date.now();
  if (!isObj(body) || Object.keys(body).some((k) => !CREATE_KEYS.includes(k)))
    return bad(400, "bad body");
  if (body.tap !== true) return bad(400, "no tap");
  const title = cleanTitle(body.title);
  if (!title) return bad(400, "bad title");
  if (!isMimeOk(body.mimeAv) || !/^video\//i.test(body.mimeAv)) return bad(400, "bad mime");
  if (!isMimeOk(body.mimeAudio) || !/^audio\//i.test(body.mimeAudio)) return bad(400, "bad mime");
  const width = dim(body.width);
  const height = dim(body.height);
  if (Number.isNaN(width) || Number.isNaN(height)) return bad(400, "bad size");
  if (typeof body.hasMic !== "boolean" || typeof body.hasRoomAudio !== "boolean")
    return bad(400, "bad tracks");
  const device = body.device ?? "";
  if (
    typeof device !== "string" ||
    device.length > MAX_DEVICE_CHARS ||
    !/^[A-Za-z0-9._ -]*$/.test(device)
  )
    return bad(400, "bad device");
  const transcript = body.transcript ?? "none";
  if (!(TRANSCRIPTS as readonly unknown[]).includes(transcript)) return bad(400, "bad transcript");
  if ((await usedBytes(d)) >= d.limits.quotaBytes) return bad(429, "quota full");
  const id = newMeetingId();
  const key = await d.key();
  await d.db
    .prepare(
      "INSERT INTO meeting (user_id, id, title_sealed, status, started_at, mime_av, mime_audio, width, height, has_mic, has_room_audio, device, transcript, transcript_status) VALUES (?, ?, ?, 'recording', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      d.uid,
      id,
      await sealText(key, title, titleAad(d.uid, id)),
      now,
      body.mimeAv,
      body.mimeAudio,
      width,
      height,
      body.hasMic ? 1 : 0,
      body.hasRoomAudio ? 1 : 0,
      device,
      transcript,
      transcript === "none" ? "none" : "waiting",
    )
    .run();
  return {
    status: 200,
    json: { ok: true, id, startedAt: now, chunkMs: d.limits.chunkMs, maxMs: d.limits.maxMs },
  };
}

/**
 * One piece. Idempotent per (meeting, track, seq): the same bytes again
 * answer `{dup: true}`, other bytes under a stored seq 409.
 */
export async function putChunk(
  d: MeetDeps,
  id: string,
  track: Track,
  seq: number,
  h: ChunkHeaders,
  bytes: Uint8Array,
): Promise<Out> {
  const now = d.now ?? Date.now();
  if (!MEETING_ID_RE.test(id)) return bad(400, "bad id");
  if (!Number.isInteger(seq) || seq < 0 || seq > MAX_SEQ) return bad(400, "bad seq");
  if (!bytes.length) return bad(400, "empty");
  if (bytes.length > MAX_CHUNK_BYTES) return bad(413, "too large");
  const m = await row(d, id);
  if (!m) return bad(404, "not found");
  const open =
    m.status === "recording" || (m.status === "interrupted" && now - m.startedAt < LEFTOVER_MS);
  if (!open) return bad(409, "closed");
  const have = await d.db
    .prepare(
      "SELECT sha256 FROM meeting_chunk WHERE user_id = ? AND meeting_id = ? AND track = ? AND seq = ?",
    )
    .bind(d.uid, id, track, seq)
    .first<{ sha256: string }>();
  if (have)
    return have.sha256 === h.sha256
      ? { status: 200, json: { ok: true, dup: true } }
      : bad(409, "seq taken");
  if ((await sha256Hex(bytes)) !== h.sha256) return bad(400, "bad hash");
  if (h.startMs > d.limits.maxMs + d.limits.chunkMs) return bad(400, "too long");
  if ((await usedBytes(d)) + bytes.length > d.limits.quotaBytes) return bad(413, "quota full");
  const obj = chunkKey(d.uid, id, track, seq);
  await d.blobs.put(obj, await sealChunk(await d.key(), d.uid, id, track, seq, bytes));
  try {
    await d.db.batch([
      d.db
        .prepare(
          "INSERT INTO meeting_chunk (user_id, meeting_id, track, seq, start_ms, dur_ms, bytes, sha256, frag_off, frag_ms, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          d.uid,
          id,
          track,
          seq,
          h.startMs,
          h.durMs,
          bytes.length,
          h.sha256,
          h.fragOff,
          h.fragMs,
          now,
        ),
      d.db
        .prepare(
          "UPDATE meeting SET bytes = bytes + ?, duration_ms = MAX(duration_ms, ?), last_chunk_at = ? WHERE user_id = ? AND id = ?",
        )
        .bind(bytes.length, h.startMs + h.durMs, now, d.uid, id),
    ]);
  } catch (e) {
    // A concurrent PUT of the same seq won the row: answer as it did, keep its object.
    const won = await d.db
      .prepare(
        "SELECT sha256 FROM meeting_chunk WHERE user_id = ? AND meeting_id = ? AND track = ? AND seq = ?",
      )
      .bind(d.uid, id, track, seq)
      .first<{ sha256: string }>();
    if (won?.sha256 === h.sha256) return { status: 200, json: { ok: true, dup: true } };
    await d.blobs.delete(obj).catch(() => {});
    throw e;
  }
  return { status: 200, json: { ok: true } };
}

/** Stop: `ended`, or `interrupted` (left-over pieces sent on a later visit). Idempotent. */
export async function endMeeting(d: MeetDeps, id: string, body: unknown): Promise<Out> {
  const now = d.now ?? Date.now();
  if (!MEETING_ID_RE.test(id)) return bad(400, "bad id");
  const b = isObj(body) ? body : {};
  const m = await row(d, id);
  if (!m) return bad(404, "not found");
  if (m.status !== "recording") return { status: 200, json: { ok: true, status: m.status } };
  const status = b.interrupted === true ? "interrupted" : "ended";
  await d.db
    .prepare(
      "UPDATE meeting SET status = ?, ended_at = ? WHERE user_id = ? AND id = ? AND status = 'recording'",
    )
    .bind(status, now, d.uid, id)
    .run();
  return { status: 200, json: { ok: true, status } };
}

/** The list, newest first; cursor "<startedAt>.<id>" of the last row. */
export async function listMeetings(d: MeetDeps, q: URLSearchParams): Promise<Out> {
  const raw = q.get("limit");
  const n = raw === null ? LIST_PAGE : Number(raw);
  if (!Number.isInteger(n) || n < 1) return bad(400, "bad limit");
  const limit = Math.min(n, LIST_PAGE_MAX);
  const before = q.get("before");
  let at = Number.MAX_SAFE_INTEGER;
  let afterId = "";
  if (before !== null) {
    const m = /^(\d{1,16})\.([A-Za-z0-9_-]{22})$/.exec(before);
    if (!m) return bad(400, "bad before");
    at = Number(m[1]);
    afterId = m[2];
  }
  const rows =
    (
      await d.db
        .prepare(
          `SELECT ${COLS} FROM meeting WHERE user_id = ? AND status != 'deleting' AND (started_at < ? OR (started_at = ? AND id < ?)) ORDER BY started_at DESC, id DESC LIMIT ?`,
        )
        .bind(d.uid, at, at, afterId, limit)
        .all<Row>()
    ).results ?? [];
  const meetings: MeetingView[] = [];
  for (const r of rows) meetings.push(await view(d, r));
  const last = rows.at(-1);
  return {
    status: 200,
    json: {
      meetings,
      next: rows.length >= limit && last ? `${last.startedAt}.${last.id}` : null,
      usedBytes: await usedBytes(d),
      quotaBytes: d.limits.quotaBytes,
    },
  };
}

export async function chunkList(d: MeetDeps, id: string): Promise<ChunkMeta[]> {
  const r = await d.db
    .prepare(
      "SELECT track, seq, start_ms AS startMs, dur_ms AS durMs, bytes, frag_off AS fragOff, frag_ms AS fragMs FROM meeting_chunk WHERE user_id = ? AND meeting_id = ? ORDER BY track, seq",
    )
    .bind(d.uid, id)
    .all<ChunkMeta>();
  return r.results ?? [];
}

/** `GET …/chunks[?track=t]`: the stored pieces, by track then seq (the transcriber's index). */
export async function chunkIndex(d: MeetDeps, id: string, track: string | null): Promise<Out> {
  if (!MEETING_ID_RE.test(id)) return bad(400, "bad id");
  if (track !== null && !isTrack(track)) return bad(400, "bad track");
  if (!(await row(d, id))) return bad(404, "not found");
  const all = await chunkList(d, id);
  return {
    status: 200,
    json: { chunks: track === null ? all : all.filter((c) => c.track === track) },
  };
}

export async function getMeeting(d: MeetDeps, id: string): Promise<Out> {
  if (!MEETING_ID_RE.test(id)) return bad(400, "bad id");
  const m = await row(d, id);
  if (!m) return bad(404, "not found");
  return { status: 200, json: { meeting: await view(d, m), chunks: await chunkList(d, id) } };
}

export async function patchMeeting(d: MeetDeps, id: string, body: unknown): Promise<Out> {
  if (!MEETING_ID_RE.test(id)) return bad(400, "bad id");
  if (
    !isObj(body) ||
    Object.keys(body).some((k) => k !== "title" && k !== "transcript") ||
    !Object.keys(body).length
  )
    return bad(400, "bad body");
  const m = await row(d, id);
  if (!m) return bad(404, "not found");
  if (body.title !== undefined) {
    const title = cleanTitle(body.title);
    if (!title) return bad(400, "bad title");
    await d.db
      .prepare("UPDATE meeting SET title_sealed = ? WHERE user_id = ? AND id = ?")
      .bind(await sealText(await d.key(), title, titleAad(d.uid, id)), d.uid, id)
      .run();
  }
  if (body.transcript !== undefined) {
    if (!(TRANSCRIPTS as readonly unknown[]).includes(body.transcript))
      return bad(400, "bad transcript");
    const t = body.transcript as TranscriptChoice;
    await d.db
      .prepare(
        "UPDATE meeting SET transcript = ?, transcript_status = ? WHERE user_id = ? AND id = ?",
      )
      .bind(
        t,
        t === "none" ? "none" : m.transcriptStatus === "done" ? "done" : "waiting",
        d.uid,
        id,
      )
      .run();
  }
  return { status: 200, json: { ok: true } };
}

/** One piece's plain bytes, or why not. */
export async function chunkBytes(
  d: MeetDeps,
  id: string,
  track: Track,
  seq: number,
): Promise<{ bytes: Uint8Array; mime: string; startMs: number; durMs: number } | Out> {
  if (!MEETING_ID_RE.test(id)) return bad(400, "bad id");
  const m = await row(d, id);
  if (!m) return bad(404, "not found");
  const c = await d.db
    .prepare(
      "SELECT start_ms AS startMs, dur_ms AS durMs FROM meeting_chunk WHERE user_id = ? AND meeting_id = ? AND track = ? AND seq = ?",
    )
    .bind(d.uid, id, track, seq)
    .first<{ startMs: number; durMs: number }>();
  if (!c) return bad(404, "not found");
  const sealed = await d.blobs.get(chunkKey(d.uid, id, track, seq));
  const bytes = sealed ? await openChunk(await d.key(), d.uid, id, track, seq, sealed) : null;
  if (!bytes) return bad(410, "unreadable");
  return {
    bytes,
    mime: track === "av" ? m.mimeAv : m.mimeAudio,
    startMs: c.startMs,
    durMs: c.durMs,
  };
}

/**
 * The video as one file: the av pieces read, opened and written one at a
 * time (memory holds one piece). A piece that does not open is skipped.
 */
export async function downloadAv(
  d: MeetDeps,
  id: string,
): Promise<{ stream: ReadableStream<Uint8Array>; mime: string; name: string } | Out> {
  if (!MEETING_ID_RE.test(id)) return bad(400, "bad id");
  const m = await row(d, id);
  if (!m) return bad(404, "not found");
  const seqs = (await chunkList(d, id)).filter((c) => c.track === "av").map((c) => c.seq);
  if (!seqs.length) return bad(404, "empty");
  const key = await d.key();
  const { uid, blobs } = d;
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(ctl) {
      while (i < seqs.length) {
        const seq = seqs[i++];
        const sealed = await blobs.get(chunkKey(uid, id, "av", seq));
        const plain = sealed ? await openChunk(key, uid, id, "av", seq, sealed) : null;
        if (plain) {
          ctl.enqueue(plain);
          return;
        }
      }
      ctl.close();
    },
  });
  const day = new Date(m.startedAt).toISOString().slice(0, 10);
  return {
    stream,
    mime: m.mimeAv.split(";")[0],
    name: `lianki-meeting-${day}-${id.slice(0, 6)}.${extOf(m.mimeAv)}`,
  };
}

/** Gone for the user at once (`deleting`), then purged: objects, then rows. */
export async function deleteMeeting(d: MeetDeps, id: string): Promise<Out> {
  if (!MEETING_ID_RE.test(id)) return bad(400, "bad id");
  const r = await d.db
    .prepare(
      "UPDATE meeting SET status = 'deleting' WHERE user_id = ? AND id = ? AND status != 'deleting'",
    )
    .bind(d.uid, id)
    .run();
  const changed = (r.meta?.changes ?? 0) === 1;
  // Cut short (the Worker's time runs out), the daily sweep finishes it.
  if (changed) await purgeMeeting(d.db as never, d.blobs, d.uid, id);
  return { status: 200, json: { ok: true, deleted: changed ? 1 : 0 } };
}

// ---------------------------------------------------------------- transcript lines

/** One line, as the voice side writes and reads it. `text` is sealed at rest. */
export type Line = {
  track: AudioTrack;
  startMs: number;
  endMs: number;
  speaker: string | null;
  lang: string | null;
  text: string;
  source: "live" | "final";
};
export const LINE_LIMITS = {
  /** Lines per PUT. */
  perPut: 200,
  /** One line's text, UTF-16 units. */
  textChars: 2_000,
  /** A PUT body. */
  bodyBytes: 512 * 1024,
  speakerChars: 40,
} as const;
const DAY = 86_400_000;
const LINE_KEYS = ["track", "startMs", "endMs", "speaker", "lang", "text"];
const isSpan = (s: unknown, e: unknown): boolean =>
  Number.isSafeInteger(s) &&
  Number.isSafeInteger(e) &&
  (s as number) >= 0 &&
  (e as number) > (s as number) &&
  (e as number) <= DAY;

/** A lines PUT: `{source, lines, replace?}`; `replace` = {track, startMs, endMs}. */
export type LinesPut = {
  source: "live" | "final";
  lines: Line[];
  replace: { track: AudioTrack; startMs: number; endMs: number } | null;
};

export function parseLines(body: unknown): LinesPut | string {
  if (!isObj(body) || Object.keys(body).some((k) => !["source", "lines", "replace"].includes(k)))
    return "bad body";
  const source = body.source;
  if (source !== "live" && source !== "final") return "bad source";
  const list = body.lines;
  if (!Array.isArray(list)) return "bad body";
  if (list.length > LINE_LIMITS.perPut) return "too many";
  let replace: LinesPut["replace"] = null;
  if (body.replace !== undefined && body.replace !== null) {
    const r = body.replace;
    if (!isObj(r) || Object.keys(r).some((k) => !["track", "startMs", "endMs"].includes(k)))
      return "bad replace";
    if (!isAudioTrack(r.track) || !isSpan(r.startMs, r.endMs)) return "bad replace";
    replace = { track: r.track, startMs: r.startMs as number, endMs: r.endMs as number };
  }
  if (!list.length && !replace) return "no lines";
  const out: Line[] = [];
  const seen = new Set<string>();
  for (const l of list) {
    if (!isObj(l) || Object.keys(l).some((k) => !LINE_KEYS.includes(k))) return "bad line";
    if (!isAudioTrack(l.track)) return "bad track";
    if (!isSpan(l.startMs, l.endMs)) return "bad time";
    if (
      typeof l.text !== "string" ||
      l.text.length > LINE_LIMITS.textChars ||
      // oxlint-disable-next-line no-control-regex
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(l.text)
    )
      return "bad text";
    const speaker = l.speaker ?? null;
    if (
      speaker !== null &&
      (typeof speaker !== "string" ||
        speaker.length > LINE_LIMITS.speakerChars ||
        CONTROL.test(speaker))
    )
      return "bad speaker";
    const lang = l.lang ?? null;
    if (
      lang !== null &&
      (typeof lang !== "string" || !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang))
    )
      return "bad lang";
    const k = `${l.track}\0${l.startMs}`;
    if (seen.has(k)) return "duplicate line";
    seen.add(k);
    out.push({
      track: l.track,
      startMs: l.startMs as number,
      endMs: l.endMs as number,
      speaker,
      lang,
      text: l.text,
      source,
    });
  }
  return { source, lines: out, replace };
}

/**
 * Write lines (upsert on meeting, track, start), all in one D1 batch:
 *
 * - with `replace`: that track's rows starting in [startMs, endMs), live and
 *   final, are deleted first (lines may then be empty: a span cleared);
 * - else a `final` PUT deletes, per track, every `live` row overlapping its
 *   lines' span [min start, max end);
 * - then every line is upserted. A `live` line never overwrites a stored
 *   `final` at the same key.
 */
export async function putLines(d: MeetDeps, id: string, body: unknown): Promise<Out> {
  const now = d.now ?? Date.now();
  if (!MEETING_ID_RE.test(id)) return bad(400, "bad id");
  const put = parseLines(body);
  if (typeof put === "string") return bad(put === "too many" ? 413 : 400, put);
  const m = await row(d, id);
  if (!m) return bad(404, "not found");
  const key = await d.key();
  const stmts = [];
  if (put.replace) {
    stmts.push(
      d.db
        .prepare(
          "DELETE FROM meeting_line WHERE user_id = ? AND meeting_id = ? AND track = ? AND start_ms >= ? AND start_ms < ?",
        )
        .bind(d.uid, id, put.replace.track, put.replace.startMs, put.replace.endMs),
    );
  } else if (put.source === "final") {
    for (const t of AUDIO_TRACKS) {
      const finals = put.lines.filter((l) => l.track === t);
      if (!finals.length) continue;
      const from = Math.min(...finals.map((l) => l.startMs));
      const to = Math.max(...finals.map((l) => l.endMs));
      stmts.push(
        d.db
          .prepare(
            "DELETE FROM meeting_line WHERE user_id = ? AND meeting_id = ? AND track = ? AND source = 'live' AND start_ms < ? AND end_ms > ?",
          )
          .bind(d.uid, id, t, to, from),
      );
    }
  }
  for (const l of put.lines)
    stmts.push(
      d.db
        .prepare(
          `INSERT INTO meeting_line (meeting_id, track, start_ms, user_id, end_ms, speaker, lang, text_sealed, source, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (meeting_id, track, start_ms) DO UPDATE SET
             end_ms = excluded.end_ms, speaker = excluded.speaker, lang = excluded.lang,
             text_sealed = excluded.text_sealed, source = excluded.source, updated_at = excluded.updated_at
           WHERE meeting_line.user_id = excluded.user_id
             AND (meeting_line.source = 'live' OR excluded.source = 'final')`,
        )
        .bind(
          id,
          l.track,
          l.startMs,
          d.uid,
          l.endMs,
          l.speaker,
          l.lang,
          await sealText(key, l.text, lineAad(d.uid, id, l.track, l.startMs)),
          l.source,
          now,
        ),
    );
  await d.db.batch(stmts);
  return { status: 200, json: { ok: true, lines: put.lines.length } };
}

export type StoredLine = Line & { updatedAt: number };

/** Every final, plus the live lines no final (of the same track) overlaps; in time order. */
export async function readLines(d: MeetDeps, id: string): Promise<StoredLine[]> {
  const r = await d.db
    .prepare(
      `SELECT l.track, l.start_ms AS startMs, l.end_ms AS endMs, l.speaker, l.lang, l.text_sealed AS sealed, l.source, l.updated_at AS updatedAt
       FROM meeting_line l
       WHERE l.user_id = ? AND l.meeting_id = ? AND (l.source = 'final' OR NOT EXISTS (
         SELECT 1 FROM meeting_line f WHERE f.user_id = l.user_id AND f.meeting_id = l.meeting_id AND f.track = l.track
           AND f.source = 'final' AND f.start_ms < l.end_ms AND f.end_ms > l.start_ms))
       ORDER BY l.start_ms, l.track`,
    )
    .bind(d.uid, id)
    .all<Omit<StoredLine, "text"> & { sealed: string }>();
  const key = await d.key();
  const out: StoredLine[] = [];
  for (const { sealed, ...l } of r.results ?? []) {
    const text = await openText(key, sealed, lineAad(d.uid, id, l.track, l.startMs));
    if (text !== null) out.push({ ...l, text });
  }
  return out;
}

export async function getLines(d: MeetDeps, id: string): Promise<Out> {
  if (!MEETING_ID_RE.test(id)) return bad(400, "bad id");
  if (!(await row(d, id))) return bad(404, "not found");
  return { status: 200, json: { lines: await readLines(d, id) } };
}

const stamp = (ms: number, sep: "." | ",") => {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(ms % 1000, 3)}`;
};
const who = (l: Line, names: { me: string; others: string }) =>
  l.speaker && l.speaker !== l.track ? l.speaker : names[l.track];

export function linesTxt(lines: readonly Line[], names = { me: "Me", others: "Others" }): string {
  return (
    lines
      .map((l) => `${stamp(l.startMs, ".").slice(0, 8)} [${who(l, names)}] ${l.text}`.trimEnd())
      .join("\n") + "\n"
  );
}
export function linesVtt(lines: readonly Line[], names = { me: "Me", others: "Others" }): string {
  const cues = lines.map(
    (l) =>
      `${stamp(l.startMs, ".")} --> ${stamp(l.endMs, ".")}\n<v ${who(l, names).replace(/[<>&]/g, "")}>${l.text.replace(/-->/g, "→")}`,
  );
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}

export async function transcriptFile(
  d: MeetDeps,
  id: string,
  part: "txt" | "vtt",
): Promise<{ text: string; name: string } | Out> {
  if (!MEETING_ID_RE.test(id)) return bad(400, "bad id");
  const m = await row(d, id);
  if (!m) return bad(404, "not found");
  const lines = await readLines(d, id);
  const day = new Date(m.startedAt).toISOString().slice(0, 10);
  return {
    text: part === "vtt" ? linesVtt(lines) : linesTxt(lines),
    name: `lianki-meeting-${day}-${id.slice(0, 6)}.${part}`,
  };
}

// ---------------------------------------------------------------- R2

/** The part of an R2 bucket meetings use. */
export type R2Like = {
  put(key: string, value: Uint8Array, o?: object): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(keys: string | string[]): Promise<void>;
  list(o: { prefix: string; cursor?: string; limit?: number }): Promise<{
    objects: { key: string }[];
    truncated: boolean;
    cursor?: string;
  }>;
};
export function r2MeetBlobs(bucket: R2Like): MeetBlobs {
  return {
    put: (key, bytes) =>
      bucket.put(key, bytes, { httpMetadata: { contentType: "application/octet-stream" } }),
    async get(key) {
      const o = await bucket.get(key);
      return o ? new Uint8Array(await o.arrayBuffer()) : null;
    },
    delete: (keys) => bucket.delete(keys),
    list: (o) => bucket.list(o),
  };
}
