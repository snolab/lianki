// The grade handle's gesture, pure (app/(app)/reader/[id]/reader-grade-handle.tsx):
// a knob resting in the middle of a track. The axis locks after the first
// movement as on /words (lockAxis): sideways is a grade by the swipe's own
// levels and release rule (lib/words/swipe.ts: swipeLevel with hysteresis,
// releaseRating, the core reporting the default side's grade); upwards past
// UNDO_PX takes the last batch back, when there is one. A tap — no travel —
// never grades, and a press that starts within the gesture that opened the
// card is ignored.

import {
  type Axis,
  levelRating,
  lockAxis,
  releaseRating,
  type SwipeLevel,
  type SwipeRating,
  swipeLevel,
} from "@/lib/words/swipe";

/** Upward travel that arms the undo (px): a row's height, as one swipe level. */
export const UNDO_PX = 44;
/** A press this soon after the card opened belongs to the tap that opened it (ms). */
export const OPENING_MS = 450;

export const openingPress = (openedAt: number, now: number) => now - openedAt < OPENING_MS;

/** Where the drag is: its axis once locked, its level sideways, undo armed upwards. */
export function handleMove(
  dx: number,
  dy: number,
  axis: Axis | null,
  held: SwipeLevel,
  a: number,
): { axis: Axis | null; level: SwipeLevel; undo: boolean } {
  const ax = axis ?? lockAxis(dx, dy);
  if (ax === "h") return { axis: ax, level: swipeLevel(dx, held, a), undo: false };
  return { axis: ax, level: 0, undo: ax === "v" && dy <= -UNDO_PX };
}

/** What letting go does. `raw` is the default side's grade (the mirror is the caller's). */
export function handleRelease(o: {
  axis: Axis | null;
  dx: number;
  dy: number;
  v: number;
  held: SwipeLevel;
  canUndo: boolean;
  a: number;
}): { kind: "grade"; raw: SwipeRating } | { kind: "undo" } | { kind: "none" } {
  if (o.axis === "h") {
    const raw = releaseRating(o.dx, o.v, o.held, o.a);
    return raw ? { kind: "grade", raw } : { kind: "none" };
  }
  if (o.axis === "v" && o.canUndo && o.dy <= -UNDO_PX) return { kind: "undo" };
  return { kind: "none" };
}

/** A due as a relative time in his language ("in 3 days", "tomorrow"). */
export function relTime(iso: string, locale: string, now = Date.now()): string {
  const ms = Date.parse(iso) - now;
  const f = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const a = Math.abs(ms);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 365 * 86_400_000],
    ["month", 30 * 86_400_000],
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];
  for (const [u, n] of units) if (a >= n) return f.format(Math.round(ms / n), u);
  return f.format(Math.round(ms / 60_000), "minute");
}

/** The grade a held level shows (default sides; mirror applied by the caller). */
export const levelGrade = levelRating;
