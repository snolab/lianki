// Timed lyrics for YouTube songs (docs/youtube-song-examples.md): the text the
// user brings — LRC, SRT or VTT — read into lines with start and end times.
// Pure and client-safe: the new-song page previews with it, the route checks
// with it. Pasted text is untrusted: parsed as text, never as HTML, capped.

/** One sung line: start and end in milliseconds, its text. */
export interface TimedLine {
  t0: number;
  t1: number;
  text: string;
}

export type TimedFormat = "lrc" | "srt" | "vtt";

export type TimedParse =
  | { ok: true; format: TimedFormat; lines: TimedLine[]; title?: string }
  | { ok: false; error: "empty" | "no-timings" | "too-large" | "too-many-lines" };

export const YT_LIMITS = {
  /** Bytes of pasted lyrics read at all. */
  maxBytes: 64 * 1024,
  /** Lines kept in one song. */
  maxLines: 500,
  /** Characters of one line. */
  maxLineChars: 300,
  /** The last line's length when nothing says where it ends. */
  lastLineMs: 8_000,
  /** No song line is longer than this, whatever the file says. */
  maxLineMs: 60_000,
  /** Times past ten hours are not a song's. */
  maxMs: 10 * 3600_000,
};

const ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * The video id of a YouTube link (`youtube.com/watch?v=`, `youtu.be/`,
 * `music.youtube.com/watch?v=`, `/shorts/`, `/embed/`, `/live/`), or a bare
 * 11-character id. Only the id is kept; anything else in the link is dropped.
 */
export function videoIdOf(input: string): string | null {
  const s = input.trim();
  if (ID.test(s)) return s;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, "");
  let id: string | null = null;
  if (host === "youtu.be") id = u.pathname.split("/")[1] ?? null;
  else if (
    host === "youtube.com" ||
    host === "music.youtube.com" ||
    host === "youtube-nocookie.com"
  ) {
    const path = u.pathname.split("/").filter(Boolean);
    if (path[0] === "watch") id = u.searchParams.get("v");
    else if (["shorts", "embed", "live", "v"].includes(path[0] ?? "")) id = path[1] ?? null;
  }
  return id && ID.test(id) ? id : null;
}

// ── Times ──────────────────────────────────────────────────────────────

/** "mm:ss", "mm:ss.xx", "mm:ss.xxx", "mm:ss:xx", "h:mm:ss,xxx" → ms; null if not a time. */
export function timeMs(s: string): number | null {
  const m = /^\s*(?:(\d{1,2}):)?(\d{1,3}):(\d{1,2})(?:[.,:](\d{1,3}))?\s*$/.exec(s);
  if (!m) return null;
  const [, h, mm, ss, frac] = m;
  const sec = Number(ss);
  if (sec >= 60) return null;
  // ".5" is half a second, ".05" five hundredths, ".005" five thousandths.
  const ms = frac ? Math.round(Number(`0.${frac}`) * 1000) : 0;
  const t = ((Number(h ?? 0) * 60 + Number(mm)) * 60 + sec) * 1000 + ms;
  return t <= YT_LIMITS.maxMs ? t : null;
}

/** Inline markup a subtitle line may carry (<i>, <c.x>, <v Name>, {\an8}), and karaoke stamps. */
function plain(text: string): string {
  return (
    text
      .replace(/<\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}>/g, " ")
      .replace(/<[^>\n]{0,200}>/g, "")
      .replace(/\{\\[^}\n]{0,100}\}/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      // Last, so "&amp;lt;" stays "&lt;" and is never unescaped twice.
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim()
      .normalize("NFC")
      .slice(0, YT_LIMITS.maxLineChars)
  );
}

/** A line with nothing to read (♪, an instrumental marker): a boundary only. */
const wordless = (text: string) => !/[\p{L}\p{N}]/u.test(text);

// ── LRC ────────────────────────────────────────────────────────────────

const LRC_STAMP = /^\[(\d{1,3}:\d{1,2}(?:[.,:]\d{1,3})?)\]/;
const LRC_TAG = /^\[([a-z#]+):([^\]]*)\]\s*$/i;

type Stamp = { t: number; t1?: number; text: string };

function parseLrc(text: string): { stamps: Stamp[]; title?: string } {
  const stamps: Stamp[] = [];
  let offset = 0;
  let title: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    let rest = raw.trim();
    const tag = LRC_TAG.exec(rest);
    if (tag && !LRC_STAMP.test(rest)) {
      const key = tag[1].toLowerCase();
      if (key === "offset" && /^\s*[+-]?\d{1,7}\s*$/.test(tag[2])) offset = Number(tag[2]);
      if (key === "ti" && tag[2].trim()) title = plain(tag[2]);
      continue;
    }
    // One line may carry several stamps: a chorus sung more than once.
    const times: number[] = [];
    for (let m = LRC_STAMP.exec(rest); m; m = LRC_STAMP.exec(rest)) {
      // An LRC stamp has no hours: "01:23:45" is mm:ss:xx (hundredths).
      const t = timeMs(m[1].replace(/^(\d+:\d{1,2}):(\d{1,3})$/, "$1.$2"));
      if (t !== null) times.push(t);
      rest = rest.slice(m[0].length).trimStart();
    }
    if (!times.length) continue;
    const line = plain(rest);
    for (const t of times) stamps.push({ t, text: line });
  }
  // LRC's [offset:]: positive means the words come sooner.
  if (offset) for (const s of stamps) s.t = Math.min(YT_LIMITS.maxMs, Math.max(0, s.t - offset));
  return { stamps, title };
}

// ── SRT / VTT ──────────────────────────────────────────────────────────

const CUE = /^\s*([\d:.,]+)\s*-->\s*([\d:.,]+)/;

function parseCues(text: string): Stamp[] {
  const out: Stamp[] = [];
  const blocks = text.replace(/\r\n?/g, "\n").split(/\n[ \t]*\n/);
  for (const block of blocks) {
    const rows = block.split("\n");
    const at = rows.findIndex((r) => CUE.test(r));
    if (at < 0) continue; // WEBVTT header, NOTE, STYLE, REGION
    const m = CUE.exec(rows[at])!;
    const t0 = timeMs(m[1]);
    const t1 = timeMs(m[2]);
    if (t0 === null || t1 === null) continue;
    const line = plain(rows.slice(at + 1).join(" "));
    out.push({ t: t0, t1: t1 > t0 ? t1 : undefined, text: line });
  }
  return out;
}

// ── Lines ──────────────────────────────────────────────────────────────

/**
 * Timed lyrics → lines sorted by start. A line's end is its cue's end when
 * the file has one, else the next stamp's start (a wordless stamp counts:
 * it marks where the line before ends); the last line runs `lastLineMs`.
 * Wordless lines are dropped after that. Lines past `maxLines` are an error,
 * not cut: half a song would read as the whole of it.
 */
export function parseTimedText(input: string): TimedParse {
  if (new TextEncoder().encode(input).byteLength > YT_LIMITS.maxBytes)
    return { ok: false, error: "too-large" };
  const text = input.replace(/^﻿/, "");
  if (!text.trim()) return { ok: false, error: "empty" };

  // SRT and VTT cues have an arrow between their times; LRC never does.
  const cues = text.includes("-->");
  const format: TimedFormat = cues ? (/^\s*WEBVTT/.test(text) ? "vtt" : "srt") : "lrc";
  const parsed = cues ? { stamps: parseCues(text) } : parseLrc(text);
  const stamps = parsed.stamps.map((s, i) => ({ ...s, i })).sort((a, b) => a.t - b.t || a.i - b.i);

  const lines: TimedLine[] = [];
  for (let k = 0; k < stamps.length; k++) {
    const s = stamps[k];
    if (wordless(s.text)) continue;
    const next = stamps.slice(k + 1).find((n) => n.t > s.t)?.t;
    let t1 = s.t1 ?? next ?? s.t + YT_LIMITS.lastLineMs;
    t1 = Math.min(t1, s.t + YT_LIMITS.maxLineMs);
    lines.push({ t0: s.t, t1, text: s.text });
  }
  if (!lines.length) return { ok: false, error: "no-timings" };
  if (lines.length > YT_LIMITS.maxLines) return { ok: false, error: "too-many-lines" };
  const title = "title" in parsed ? parsed.title : undefined;
  return { ok: true, format, lines, ...(title ? { title } : {}) };
}

// ── Playing a line ─────────────────────────────────────────────────────

/** A line's clip as stored: [t0, t1] in ms, the song's offset not yet applied. */
export type ClipMs = readonly [number, number];

/**
 * What the player is asked for: `loadVideoById({startSeconds, endSeconds})`.
 * The song's offset moves both ends (positive: the words come later in the
 * video); nothing starts before 0, and the end stays after the start and,
 * once the player knows the video's length, inside it.
 */
export function clipSeconds(
  clip: ClipMs,
  offsetMs = 0,
  durationSec?: number,
): { startSeconds: number; endSeconds: number } {
  const start = Math.max(0, clip[0] + offsetMs);
  let end = Math.max(start + 250, clip[1] + offsetMs);
  if (durationSec && durationSec > 0) end = Math.min(end, durationSec * 1000);
  const r = (ms: number) => Math.round(ms) / 1000;
  return { startSeconds: r(start), endSeconds: r(Math.max(end, start + 1)) };
}
