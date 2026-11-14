/**
 * /my/recordings as an article (owner, 2026-11-14 22:4x JST; docs/recordings.md,
 * "The page"): a day's clips read as one text, one paragraph per clip, with a
 * mark (speaker, device) only where it changes, and one continuous timeline
 * for the whole day — the clips end to end in recording order, the silence
 * between them not drawn. Pure, so it is unit-tested; RecordingsClient.tsx is
 * the glue (one shared <audio>).
 */
import type { ClipView } from "@/lib/recordings-view";

/** Who spoke and on what: shown at a paragraph only when it differs from the one before. */
export type Mark = { speaker: "me" | "other" | null; device: string | null };

export type Paragraph = {
  c: ClipView;
  /** Where this clip starts on the day's timeline, ms (the earlier clips' durations summed). */
  startMs: number;
  /** The mark to show at this paragraph's start, or null when it is the same as before. */
  mark: Mark | null;
};

const markOf = (c: ClipView): Mark => ({
  speaker: c.speaker === "me" || c.speaker === "other" ? c.speaker : null,
  device: c.device?.trim() || null,
});
const sameMark = (a: Mark, b: Mark) => a.speaker === b.speaker && a.device === b.device;
const emptyMark = (m: Mark) => m.speaker === null && m.device === null;

/** A day's clips (any order) as its paragraphs, in recording order, on one timeline. */
export function paragraphs(clips: readonly ClipView[]): Paragraph[] {
  const sorted = [...clips].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: Paragraph[] = [];
  let at = 0;
  let prev: Mark | null = null;
  for (const c of sorted) {
    const m = markOf(c);
    const changed = prev === null ? !emptyMark(m) : !sameMark(prev, m);
    out.push({ c, startMs: at, mark: changed ? m : null });
    prev = m;
    at += Math.max(0, c.durationMs);
  }
  return out;
}

/** The day's whole length on the timeline, ms. */
export const totalMs = (ps: readonly Paragraph[]): number =>
  ps.length ? ps[ps.length - 1].startMs + Math.max(0, ps[ps.length - 1].c.durationMs) : 0;

/**
 * The paragraph under a point of the day's timeline, and how far into its clip:
 * clamped to the day; a point on a boundary belongs to the clip that starts
 * there. Null for a day with no clips.
 */
export function locate(
  ps: readonly Paragraph[],
  ms: number,
): { index: number; offsetMs: number } | null {
  if (!ps.length) return null;
  const t = Math.max(0, Math.min(totalMs(ps), Number.isFinite(ms) ? ms : 0));
  let lo = 0;
  let hi = ps.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ps[mid].startMs <= t) lo = mid;
    else hi = mid - 1;
  }
  // Clips of no length share a start with the next: the last of them (the one that plays) wins.
  const index = lo;
  const offsetMs = Math.min(
    Math.max(0, t - ps[index].startMs),
    Math.max(0, ps[index].c.durationMs),
  );
  return { index, offsetMs };
}

/** A point on the day's timeline from the playing clip and its audio's currentTime (seconds). */
export function positionMs(p: Paragraph, currentTimeS: number): number {
  const into = Number.isFinite(currentTimeS) ? Math.max(0, currentTimeS * 1000) : 0;
  return p.startMs + Math.min(into, Math.max(0, p.c.durationMs));
}

/** What the one player is doing: which clip (by id), of which day, playing or paused. */
export type PlayerState = { day: string; id: string; playing: boolean } | null;

export type PlayAction =
  | { do: "pause" }
  | { do: "resume" }
  | { do: "play"; day: string; id: string; fromMs: number };

/**
 * A tap on a paragraph (`restart: false`) or "Play from here" (`restart: true`):
 * the playing paragraph pauses on a tap; the paused current one resumes; any
 * other starts its clip from the beginning.
 */
export function playTarget(
  state: PlayerState,
  tapped: { day: string; id: string },
  restart = false,
): PlayAction {
  const current = state && state.day === tapped.day && state.id === tapped.id;
  if (current && !restart) return state.playing ? { do: "pause" } : { do: "resume" };
  return { do: "play", day: tapped.day, id: tapped.id, fromMs: 0 };
}

/** The clip after this one in its day, for playing on, or null at the day's end. */
export function nextId(ps: readonly Paragraph[], id: string): string | null {
  const i = ps.findIndex((p) => p.c.id === id);
  return i >= 0 && i + 1 < ps.length ? ps[i + 1].c.id : null;
}

/** Playback speeds offered (config `recordings.speeds`, a comma list); bad entries dropped, 1 always in. */
export function parseSpeeds(raw: string): number[] {
  const out = new Set<number>();
  for (const s of raw.split(",")) {
    const n = Number(s.trim());
    if (s.trim() && Number.isFinite(n) && n >= 0.25 && n <= 4) out.add(Math.round(n * 100) / 100);
  }
  out.add(1);
  return [...out].sort((a, b) => a - b);
}

/** The device's chosen speed (localStorage `lk:pref:recordings-speed`), when it is one offered; else 1. */
export function speedFrom(stored: string | null | undefined, speeds: readonly number[]): number {
  const n = Number(stored);
  return stored && speeds.includes(n) ? n : 1;
}

/** localStorage key of the device's playback speed (docs/ui-state.md: a device preference). */
export const SPEED_KEY = "lk:pref:recordings-speed";
