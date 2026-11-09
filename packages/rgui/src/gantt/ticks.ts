/**
 * rgui gantt — tick choice on the time scales (pure).
 *
 * The readable-grid rule (core/grid.ts readableStep): the finest step whose
 * on-screen spacing is at least the readable minimum. On a time axis the
 * ladder is a human one (1, 2, 5, 10, 15, 30 minutes … a week); past its last
 * rung the step climbs rgui's radix ladder (powers of two weeks) by
 * readableStep itself, so there is always a readable step, at any zoom.
 * The log axis takes round distances outward from Now, each one only when
 * its label clears the last one taken: no two labels overlap, at any zoom.
 */
import { readableStep } from "../core/grid";
import {
  DAY,
  HOUR,
  MIN,
  WEEK,
  isLog,
  logX,
  timeAt,
  xOf,
  type Axis,
  type GanttAxis,
  type LogAxis,
} from "./scale";

/** Ticks at least this far apart (px). */
export const TICK_MIN_PX = 72;
/** The width of a digit at the axis's 12 px text (px); a host passes the measured one. */
export const CHAR_PX = 8;
/** The clear space between two tick labels (px). */
export const TICK_GAP_PX = 10;

/** The tick steps the linear axis picks from, smallest first. */
export const TICK_STEPS = [
  MIN,
  2 * MIN,
  5 * MIN,
  10 * MIN,
  15 * MIN,
  30 * MIN,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  WEEK,
];

/**
 * The smallest step at least `minPx` (TICK_MIN_PX, or more for a larger text
 * size: tickMinPx) apart at this zoom. Past the ladder: a power-of-two count
 * of weeks (rgui's readableStep at radix 2).
 */
export function tickStep(pxPerMs: number, minPx = TICK_MIN_PX): number {
  const step = TICK_STEPS.find((s) => s * pxPerMs >= minPx);
  if (step !== undefined) return step;
  return WEEK * readableStep(pxPerMs * WEEK, minPx, 2);
}

/** A label's width estimate (px) for a text whose digits are `charPx` wide, its padding included. */
export const labelPx = (label: string, charPx = CHAR_PX) => label.length * charPx + charPx;

/** The longest linear label ("-13.5D") never meets its neighbour: the step is at least this far apart. */
export const tickMinPx = (charPx = CHAR_PX) =>
  Math.max(TICK_MIN_PX, labelPx("-13.5D", charPx) + TICK_GAP_PX);

/**
 * A tick's label, relative to now, language-neutral: "Now", "30M", "-30M",
 * "2H", "1.5H", "-6H", "1D", "-2D". Minutes under an hour, hours (one
 * decimal) under a day, days (one decimal) from a day.
 */
export function axisLabel(dt: number): string {
  if (Math.abs(dt) < MIN / 2) return "Now";
  const sign = dt < 0 ? "-" : "";
  const abs = Math.abs(dt);
  if (abs < HOUR) return `${sign}${Math.round(abs / MIN)}M`;
  if (abs < DAY) return `${sign}${Math.round((abs / HOUR) * 10) / 10}H`;
  return `${sign}${Math.round((abs / DAY) * 10) / 10}D`;
}

export type Tick = { t: number; x: number; label: string; now: boolean };

/**
 * The linear axis's ticks around the view (a screen either side), on whole
 * steps from now, so the labels are round ("-1H", "Now", "1H"). Bounded: at
 * most a few screens' worth, whatever the range.
 */
export function axisTicks(
  a: Axis,
  scrollLeft: number,
  w: number,
  now: number,
  charPx = CHAR_PX,
): Tick[] {
  const width = Math.max(1, w);
  const step = tickStep(a.pxPerMs, tickMinPx(charPx));
  const from = Math.max(a.lo, timeAt(a, scrollLeft - width));
  const to = Math.min(a.hi, timeAt(a, scrollLeft + 2 * width));
  const out: Tick[] = [];
  for (let k = Math.ceil((from - now) / step); now + k * step <= to; k++) {
    const t = now + k * step;
    out.push({ t, x: xOf(a, t), label: axisLabel(t - now), now: k === 0 });
  }
  return out;
}

/**
 * The distances from Now (either side) a log tick may stand at: round values
 * in minutes, hours and days, so the labels read "5M", "3H", "2D", "-90D".
 */
export const LOG_TICKS = [
  ...[1, 2, 3, 5, 10, 15, 20, 30, 45].map((m) => m * MIN),
  ...[1, 1.5, 2, 3, 4, 6, 8, 12, 18].map((h) => h * HOUR),
  ...[1, 1.5, 2, 3, 4, 5, 7, 10, 14, 21, 30, 45, 60, 90, 120, 180, 270, 365].map((d) => d * DAY),
  ...[2, 3, 5, 10, 20, 50, 100, 200, 500, 1000].map((y) => y * 365 * DAY),
];

/**
 * The log axis's ticks around the view: Now, then outward on each side the
 * next round distance (LOG_TICKS) whose label clears the last one taken by
 * TICK_GAP_PX (labels estimated at `charPx` a character), so no two labels
 * ever overlap, at any zoom. Only those within a screen of the view are
 * returned (a bounded DOM).
 */
export function logTicks(
  a: LogAxis,
  scrollLeft: number,
  w: number,
  now: number,
  charPx = CHAR_PX,
): Tick[] {
  const width = Math.max(1, w);
  const x0 = logX(a, now, now);
  const all: Tick[] = [{ t: now, x: x0, label: "Now", now: true }];
  for (const side of [-1, 1]) {
    let lastX = x0;
    let lastW = labelPx("Now", charPx);
    for (const d of LOG_TICKS) {
      const t = now + side * d;
      const x = logX(a, t, now);
      const label = axisLabel(side * d);
      const lw = labelPx(label, charPx);
      if (Math.abs(x - lastX) < (lw + lastW) / 2 + TICK_GAP_PX) continue;
      all.push({ t, x, label, now: false });
      lastX = x;
      lastW = lw;
    }
  }
  return all
    .filter((k) => k.x >= scrollLeft - width && k.x <= scrollLeft + 2 * width)
    .sort((p, q) => p.x - q.x);
}

/** The ticks around the view on either axis. */
export const scaleTicks = (
  a: GanttAxis,
  scrollLeft: number,
  w: number,
  now: number,
  charPx = CHAR_PX,
) =>
  isLog(a) ? logTicks(a, scrollLeft, w, now, charPx) : axisTicks(a, scrollLeft, w, now, charPx);
