/**
 * Meetings (docs/meetings.md): the shared, pure pieces — names, limits, keys,
 * the request-header parser, format choice and fragment finding. Client-safe:
 * no D1, no crypto keys, no request plumbing. lib/meetings/store.ts is the
 * server logic, lib/meetings/capture.ts the browser recorder.
 */

/** av = screen video + the mixed sound (one continuous file); me = mic only; others = the shared screen's sound only. */
export const TRACKS = ["av", "me", "others"] as const;
export type Track = (typeof TRACKS)[number];
/** The audio-only tracks a transcript reads (and meeting_line.track takes). */
export const AUDIO_TRACKS = ["me", "others"] as const;
export type AudioTrack = (typeof AUDIO_TRACKS)[number];
export const isTrack = (s: unknown): s is Track => (TRACKS as readonly unknown[]).includes(s);
export const isAudioTrack = (s: unknown): s is AudioTrack =>
  (AUDIO_TRACKS as readonly unknown[]).includes(s);

export const STATUSES = ["recording", "ended", "interrupted", "deleting"] as const;
export type MeetingStatus = (typeof STATUSES)[number];
export const TRANSCRIPTS = ["none", "local", "cloud"] as const;
export type TranscriptChoice = (typeof TRANSCRIPTS)[number];
export const TRANSCRIPT_STATUSES = ["none", "waiting", "running", "done", "failed"] as const;
export type TranscriptStatus = (typeof TRANSCRIPT_STATUSES)[number];

/**
 * Hard caps. Named constants, not config keys: they bound what the Worker
 * holds in memory (128 MB an isolate; a request body ≤ 100 MB on Free/Pro).
 */
export const MAX_CHUNK_BYTES = 32 * 1024 * 1024;
/** Pieces per track at most: 600 min at 10 s pieces. */
export const MAX_SEQ = 3_600;
export const MAX_TITLE_CHARS = 200;
export const MAX_DEVICE_CHARS = 40;
export const MAX_MIME_CHARS = 120;
/** A meeting's id: 16 random bytes, base64url without padding. */
export const MEETING_ID_RE = /^[A-Za-z0-9_-]{22}$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;
/** Meetings listed per GET, by default and at most. */
export const LIST_PAGE = 30;
export const LIST_PAGE_MAX = 100;
/** Left-over pieces of an interrupted meeting are still taken for this long after its start. */
export const LEFTOVER_MS = 86_400_000;

/** A new meeting id (16 random bytes, base64url). */
export function newMeetingId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const seqName = (seq: number) => String(seq).padStart(6, "0");
/** Every object of one meeting sits under this prefix. */
export const meetingPrefix = (uid: string, id: string) => `meetings/${uid}/${id}/`;
/** The R2 object of one piece (the interface the voice side reads). */
export const chunkKey = (uid: string, id: string, track: Track, seq: number) =>
  `${meetingPrefix(uid, id)}${track}/${seqName(seq)}`;

/** The headers a PUT of one piece carries, parsed; a string says what is wrong. */
export type ChunkHeaders = {
  sha256: string;
  startMs: number;
  durMs: number;
  fragOff: number | null;
  fragMs: number | null;
};
const nonNegInt = (s: string | null, max: number): number | null => {
  if (s === null || !/^\d{1,12}$/.test(s)) return null;
  const n = Number(s);
  return n <= max ? n : null;
};
export function parseChunkHeaders(h: { get(name: string): string | null }): ChunkHeaders | string {
  const sha256 = (h.get("x-lk-sha256") ?? "").toLowerCase();
  if (!SHA256_RE.test(sha256)) return "bad sha256";
  const day = 86_400_000;
  const startMs = nonNegInt(h.get("x-lk-start-ms"), day);
  if (startMs === null) return "bad start";
  const durMs = nonNegInt(h.get("x-lk-dur-ms"), 600_000);
  if (durMs === null) return "bad dur";
  const rawOff = h.get("x-lk-frag-off");
  const rawFms = h.get("x-lk-frag-ms");
  const fragOff = rawOff === null || rawOff === "" ? null : nonNegInt(rawOff, MAX_CHUNK_BYTES);
  const fragMs = rawFms === null || rawFms === "" ? null : nonNegInt(rawFms, day);
  if (rawOff && fragOff === null) return "bad frag";
  if (rawFms && fragMs === null) return "bad frag";
  return { sha256, startMs, durMs, fragOff, fragMs };
}

/** "seq" from a path segment: a whole number 0…MAX_SEQ written plainly. */
export function parseSeq(s: string): number | null {
  if (!/^\d{1,6}$/.test(s)) return null;
  const n = Number(s);
  return n <= MAX_SEQ ? n : null;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------- formats

/**
 * config `meetings.mimeTypes`: "av: t | t | t || audio: t | t". The types
 * themselves hold ";codecs=", so groups are split by "||" and entries by "|".
 */
export function parseMimePrefs(s: string): { av: string[]; audio: string[] } | null {
  if (typeof s !== "string" || s.length > 1000) return null;
  const groups = s.split("||").map((g) => g.trim());
  if (groups.length !== 2) return null;
  const out: Record<string, string[]> = {};
  for (const g of groups) {
    const m = /^(av|audio)\s*:\s*(.+)$/s.exec(g);
    if (!m) return null;
    const list = m[2]
      .split("|")
      .map((t) => t.trim())
      .filter(Boolean);
    if (
      !list.length ||
      list.some((t) => !/^(video|audio)\/[a-z0-9.+-]+(;[ a-z0-9=.,+-]+)?$/i.test(t))
    )
      return null;
    out[m[1]] = list;
  }
  if (!out.av || !out.audio) return null;
  return { av: out.av, audio: out.audio };
}
export const DEFAULT_MIME_PREFS =
  "av: video/mp4;codecs=avc1,mp4a.40.2 | video/webm;codecs=vp9,opus | video/webm;codecs=vp8,opus || audio: audio/webm;codecs=opus | audio/mp4;codecs=mp4a.40.2";

/** The first type the browser records, or null (no supported type: Start stays disabled). */
export function pickMime(
  list: readonly string[],
  supported: (t: string) => boolean,
): string | null {
  for (const t of list) {
    try {
      if (supported(t)) return t;
    } catch {}
  }
  return null;
}

export const isMimeOk = (s: unknown): s is string =>
  typeof s === "string" &&
  s.length > 0 &&
  s.length <= MAX_MIME_CHARS &&
  /^(video|audio)\/[a-z0-9.+-]+(;[ a-z0-9=.,+-]+)?$/i.test(s);

/** The file extension a download of this type gets. */
export const extOf = (mime: string) => (/^(video|audio)\/mp4/i.test(mime) ? "mp4" : "webm");

/** Which browsers may record (docs/meetings.md, "What browsers can do"): desktop Chrome / Edge. */
export type Support =
  | { ok: true; tabSoundOnly: boolean }
  | { ok: false; reason: "mobile" | "browser" | "api" };
export function recordSupport(env: {
  ua: string;
  hasDisplayMedia: boolean;
  hasRecorder: boolean;
  mobile?: boolean;
}): Support {
  const ua = env.ua;
  if (env.mobile || /Android|iPhone|iPad|iPod|Mobile/i.test(ua))
    return { ok: false, reason: "mobile" };
  const chromium = /Chrome\/\d+/.test(ua) && !/OPR\/|SamsungBrowser/.test(ua);
  if (!chromium) return { ok: false, reason: "browser" };
  if (!env.hasDisplayMedia || !env.hasRecorder) return { ok: false, reason: "api" };
  // Chrome captures window and system sound only on Windows and ChromeOS.
  return { ok: true, tabSoundOnly: !/Windows|CrOS/.test(ua) };
}

// ---------------------------------------------------------------- fragments

/**
 * The byte offset of the first fragment start in a piece: a WebM Cluster
 * (EBML id 1F 43 B6 75) or an MP4 `moof` box (its size precedes the type, so
 * the box starts 4 bytes before "moof"). The player appends the header (the
 * first piece up to its first fragment), then from here, to seek in a file
 * MediaRecorder wrote without an index. -1 when the piece holds none.
 *
 * A Cluster id may also occur inside a frame's bytes; to make a false hit
 * unlikely, a WebM match must be followed by a Timecode element (E7).
 */
export function firstFragment(bytes: Uint8Array, mime: string, from = 0): number {
  const mp4 = /mp4/i.test(mime);
  for (let i = Math.max(0, from); i + 4 < bytes.length; i++) {
    if (mp4) {
      if (
        bytes[i] === 0x6d &&
        bytes[i + 1] === 0x6f &&
        bytes[i + 2] === 0x6f &&
        bytes[i + 3] === 0x66 &&
        i >= 4
      )
        return i - 4;
    } else if (
      bytes[i] === 0x1f &&
      bytes[i + 1] === 0x43 &&
      bytes[i + 2] === 0xb6 &&
      bytes[i + 3] === 0x75 &&
      clusterHasTimecode(bytes, i + 4)
    )
      return i;
  }
  return -1;
}

/** After a Cluster id: a size (EBML vint), then the Timecode element id E7. */
function clusterHasTimecode(b: Uint8Array, at: number): boolean {
  const first = b[at];
  if (first === undefined || first === 0) return false;
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  return b[at + len] === 0xe7;
}

// ---------------------------------------------------------------- playback plan

export type ChunkMeta = {
  track: Track;
  seq: number;
  startMs: number;
  durMs: number;
  bytes: number;
  fragOff: number | null;
  fragMs: number | null;
};

/**
 * Where to start appending to play from `ms`: the last av piece whose first
 * fragment starts at or before `ms` (from its `fragOff`). The header is piece
 * 0's bytes before its own first fragment. Pieces without a fragment are
 * skipped as starts; with none at all, play from piece 0's start.
 */
export function seekPlan(
  chunks: readonly ChunkMeta[],
  ms: number,
): { seq: number; offset: number; atMs: number } | null {
  const av = chunks.filter((c) => c.track === "av").sort((a, b) => a.seq - b.seq);
  if (!av.length || av[0].seq !== 0) return null;
  let best: { seq: number; offset: number; atMs: number } | null = null;
  for (const c of av) {
    if (c.fragOff === null || c.fragMs === null) continue;
    if (c.fragMs > ms) break;
    best = { seq: c.seq, offset: c.fragOff, atMs: c.fragMs };
  }
  return best ?? { seq: 0, offset: 0, atMs: 0 };
}

/** The av pieces must be one run 0…n-1 to play or download in one piece; the first missing seq, or -1. */
export function firstGap(chunks: readonly ChunkMeta[], track: Track = "av"): number {
  const seqs = new Set(chunks.filter((c) => c.track === track).map((c) => c.seq));
  let i = 0;
  while (seqs.has(i)) i++;
  return i < seqs.size ? i : -1;
}

/** The default title, "Meeting, 19 Nov 2026, 15:45" in the device's language and zone. */
export function defaultTitle(at: number, word: string, locale?: string, timeZone?: string): string {
  let when: string;
  try {
    when = new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      ...(timeZone ? { timeZone } : {}),
    }).format(new Date(at));
  } catch {
    when = new Date(at).toISOString().slice(0, 16).replace("T", " ");
  }
  return `${word}, ${when}`;
}

/** "1:02:03" / "4:05" for a length in ms. */
export function clockOf(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** "4.5 MB" for a size in bytes (decimal units, as browsers show downloads). */
export function sizeOf(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let v = bytes / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Pages whose content is meetings: no eval runs there, the chat sends nothing from them. */
export const isMeetingsPath = (pathname: string) =>
  /^(\/[a-z]{2}(-[a-z]+)?)?\/my\/meetings(\/|$)/i.test(pathname);
