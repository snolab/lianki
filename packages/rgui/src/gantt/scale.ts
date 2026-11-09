/**
 * rgui gantt — the time scales a Gantt draws on (pure).
 *
 * Two axes, one interface (`scaleX`, `scaleZoom`, …):
 *
 * - linear: x = (t − lo) · pxPerMs, a native scroller that grows on demand
 *   (`extendAxis`) and is trimmed past MAX_SCREENS, so it is bounded;
 * - symmetric log around Now: u = sign(dt) · L · ln(1 + |dt| / T), linear
 *   within about T of Now, every e-fold of distance the same L px further
 *   out, so minutes and days share a screen (`symlog` / `symexp`).
 *
 * The unit lengths are rgui's temporal fold periods (lane/temporal.ts
 * FOLD_PERIOD_MS), so a Gantt's hour and day are the lane's.
 *
 * Ported from Lianki's debug-chat gantt-view.ts (#739 linear, #747 log), which
 * now re-exports these.
 */
import { FOLD_PERIOD_MS } from "../lane/temporal";

export const HOUR = FOLD_PERIOD_MS.hour!;
export const MIN = HOUR / 60;
export const DAY = FOLD_PERIOD_MS.day!;
export const WEEK = FOLD_PERIOD_MS.week!;
export const MONTH = FOLD_PERIOD_MS.month!;
export const YEAR = FOLD_PERIOD_MS.year!;

/** The narrowest screen: this much time across the whole width (zoomed in). */
export const MIN_SCREEN_MS = 10 * MIN;
/** The widest screen: this much time across the whole width (zoomed out). */
export const MAX_SCREEN_MS = 14 * DAY;
/** A long range scrolls rather than squash: at least this many px per hour on open. */
export const MIN_PX_PER_HOUR = 120;
/** The axis grows by this many screens on a side when the view nears it. */
export const EXTEND_SCREENS = 2;
/** The content is trimmed on the far side past this many screens. */
export const MAX_SCREENS = 12;
/** On open, now sits this far from the left of the view. */
export const NOW_AT = 0.25;

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/* The linear axis. */

export type Axis = { lo: number; hi: number; pxPerMs: number };

export const xOf = (a: Axis, t: number) => (t - a.lo) * a.pxPerMs;
export const timeAt = (a: Axis, x: number) => a.lo + x / a.pxPerMs;
export const axisWidth = (a: Axis) => Math.round((a.hi - a.lo) * a.pxPerMs);

/** The zoom limits for a view `w` px wide (px per ms). */
export function zoomLimits(w: number) {
  const width = Math.max(1, w);
  return { min: width / MAX_SCREEN_MS, max: width / MIN_SCREEN_MS };
}

/**
 * The axis on open, for a view `w` px wide: the tasks' range [from, to] and
 * now fit in the screen past now's place (NOW_AT), but never under
 * MIN_PX_PER_HOUR (a long range scrolls). It spans a screen beyond each of
 * the tasks and now; `scrollLeft` puts now NOW_AT from the left.
 */
export function initialAxis(
  from: number,
  to: number,
  now: number,
  w: number,
): { axis: Axis; scrollLeft: number } {
  const width = Math.max(1, w);
  const lim = zoomLimits(width);
  const ahead = Math.max(to - now, 0);
  const behind = Math.max(now - from, 0);
  const fit = Math.min(
    ahead > 0 ? (width * (1 - NOW_AT) * 0.9) / ahead : Infinity,
    behind > 0 ? (width * NOW_AT * 0.9) / behind : Infinity,
  );
  const floor = MIN_PX_PER_HOUR / HOUR;
  const p = clamp(
    Number.isFinite(fit) ? Math.max(fit, floor) : width / (2 * HOUR),
    lim.min,
    lim.max,
  );
  const screen = width / p;
  const lo = Math.min(from, now - NOW_AT * screen) - screen;
  const hi = Math.max(to, now + screen) + screen;
  const axis = { lo, hi, pxPerMs: p };
  return { axis, scrollLeft: xOf(axis, now) - NOW_AT * width };
}

/**
 * Grow the axis when the view (scrollLeft, w) nears an end, and trim the far
 * side past MAX_SCREENS. Returns the new axis and the scrollLeft that keeps
 * the same time under the view; the same object when nothing changes.
 */
export function extendAxis(
  a: Axis,
  scrollLeft: number,
  w: number,
): { axis: Axis; scrollLeft: number } {
  const width = Math.max(1, w);
  const screen = width / a.pxPerMs;
  const left = timeAt(a, scrollLeft);
  const right = timeAt(a, scrollLeft + width);
  let { lo, hi } = a;
  if (left - lo < screen) lo = left - (EXTEND_SCREENS + 1) * screen;
  if (hi - right < screen) hi = right + (EXTEND_SCREENS + 1) * screen;
  const max = MAX_SCREENS * screen;
  if (hi - lo > max) {
    // Keep the view and its margins; drop what is furthest from it.
    if (lo !== a.lo) hi = Math.min(hi, Math.max(right + screen, lo + max));
    else if (hi !== a.hi) lo = Math.max(lo, Math.min(left - screen, hi - max));
    else {
      lo = Math.max(lo, left - (MAX_SCREENS / 2) * screen);
      hi = Math.min(hi, right + (MAX_SCREENS / 2) * screen);
    }
  }
  if (lo === a.lo && hi === a.hi) return { axis: a, scrollLeft };
  const axis = { lo, hi, pxPerMs: a.pxPerMs };
  return { axis, scrollLeft: xOf(axis, left) };
}

/**
 * Zoom by `factor` (> 1 in) about `anchorX`, px from the view's left: the
 * time under the anchor stays there. Clamped to zoomLimits; the range then
 * grows (extendAxis) so the view stays inside it.
 */
export function zoomAxis(
  a: Axis,
  scrollLeft: number,
  w: number,
  anchorX: number,
  factor: number,
): { axis: Axis; scrollLeft: number } {
  const lim = zoomLimits(w);
  const p = clamp(
    a.pxPerMs * (Number.isFinite(factor) && factor > 0 ? factor : 1),
    lim.min,
    lim.max,
  );
  if (p === a.pxPerMs) return { axis: a, scrollLeft };
  const t = timeAt(a, scrollLeft + anchorX);
  const left = t - anchorX / p;
  const screen = Math.max(1, w) / p;
  const lo = Math.min(a.lo, left - screen);
  const hi = Math.max(a.hi, left + 2 * screen);
  const axis = { lo, hi, pxPerMs: p };
  return extendAxis(axis, xOf(axis, left), w);
}

/**
 * Jump to now: the same zoom, now NOW_AT from the left; the range grows to
 * reach it (or is rebuilt around it when far away), trimmed like extendAxis.
 */
export function axisToNow(a: Axis, w: number, now: number): { axis: Axis; scrollLeft: number } {
  const width = Math.max(1, w);
  const screen = width / a.pxPerMs;
  const left = now - NOW_AT * screen;
  const far = left < a.lo - MAX_SCREENS * screen || left > a.hi + MAX_SCREENS * screen;
  const axis = far
    ? { lo: left - 2 * screen, hi: left + 3 * screen, pxPerMs: a.pxPerMs }
    : {
        lo: Math.min(a.lo, left - 2 * screen),
        hi: Math.max(a.hi, left + 3 * screen),
        pxPerMs: a.pxPerMs,
      };
  return extendAxis(axis, xOf(axis, left), width);
}

/* The symmetric-log axis around Now. */

export type LogAxis = { kind: "log"; T: number; L: number; uLo: number; uHi: number };
/** Either axis: the linear one (Axis) or the log one. */
export type GanttAxis = Axis | LogAxis;

export const isLog = (a: GanttAxis): a is LogAxis => "kind" in a && a.kind === "log";

/** The log axis reaches this far either side of Now (a thousand years: in effect, no end). */
export const LOG_SPAN = 1000 * 365 * DAY;
/** The linear window around Now (T): from a minute (zoomed in) to a week. */
export const LOG_MIN_T = MIN;
export const LOG_MAX_T = 7 * DAY;
/** On open the window is at least this wide, so a near task is not a sliver of seconds. */
export const LOG_OPEN_MIN_T = 2 * MIN;
/** Px per e-fold (L): zoom limits, and on open about this many e-folds per screen. */
export const LOG_MIN_L = 24;
export const LOG_MAX_L = 240;
export const LOG_E_PER_SCREEN = 8;
/** On open Now sits this far from the left: a third, the future gets the rest. */
export const LOG_NOW_AT = 1 / 3;

/** Distance from Now (ms) → px from the Now line. Odd and strictly increasing. */
export const symlog = (dt: number, T: number, L: number) =>
  Math.sign(dt) * L * Math.log1p(Math.abs(dt) / T);
/** Px from the Now line → distance from Now (ms): the inverse of symlog. */
export const symexp = (u: number, T: number, L: number) =>
  Math.sign(u) * T * Math.expm1(Math.abs(u) / L);

/** The log axis for a window T and L px per e-fold, spanning LOG_SPAN (and at least a screen) a side. */
export function logAxis(T: number, L: number, w = 0): LogAxis {
  const side = Math.max(symlog(LOG_SPAN, T, L), Math.max(1, w));
  return { kind: "log", T, L, uLo: -side, uHi: side };
}

/** A time's x on the log axis (px from the content's left); beyond LOG_SPAN it stays at the end. */
export const logX = (a: LogAxis, t: number, now: number) =>
  symlog(clamp(t - now, -LOG_SPAN, LOG_SPAN), a.T, a.L) - a.uLo;
/** The time at x on the log axis: the inverse of logX. */
export const logTimeAt = (a: LogAxis, x: number, now: number) =>
  now + symexp(x + a.uLo, a.T, a.L);

/** Px per e-fold on open for a view `w` px wide. */
export const logPxPerE = (w: number) =>
  clamp(Math.max(1, w) / LOG_E_PER_SCREEN, LOG_MIN_L, LOG_MAX_L);

/**
 * The log axis on open: Now LOG_NOW_AT from the left, and the window T as
 * narrow as lets [from, to] fit the screen (a tenth of margin), so near
 * tasks get the detail; never under LOG_OPEN_MIN_T, never past LOG_MAX_T.
 */
export function initialLogAxis(
  from: number,
  to: number,
  now: number,
  w: number,
): { axis: LogAxis; scrollLeft: number } {
  const width = Math.max(1, w);
  const L = logPxPerE(width);
  const fit = (span: number, px: number) => (span > 0 ? span / Math.expm1((px * 0.9) / L) : 0);
  const T = clamp(
    Math.max(
      fit(to - now, (1 - LOG_NOW_AT) * width),
      fit(now - from, LOG_NOW_AT * width),
      LOG_OPEN_MIN_T,
    ),
    LOG_MIN_T,
    LOG_MAX_T,
  );
  const axis = logAxis(T, L, width);
  return { axis, scrollLeft: logX(axis, now, now) - LOG_NOW_AT * width };
}

/**
 * Zoom the log axis by `factor` (> 1 in) about `anchorX`, px from the view's
 * left: L × √factor, T ÷ √factor, each within its limits; the scroll moves so
 * the time under the anchor stays there. The same object when at the limits.
 */
export function zoomLogAxis(
  a: LogAxis,
  scrollLeft: number,
  w: number,
  anchorX: number,
  factor: number,
  now: number,
): { axis: LogAxis; scrollLeft: number } {
  const f = Math.sqrt(Number.isFinite(factor) && factor > 0 ? factor : 1);
  const L = clamp(a.L * f, LOG_MIN_L, LOG_MAX_L);
  const T = clamp(a.T / f, LOG_MIN_T, LOG_MAX_T);
  if (L === a.L && T === a.T) return { axis: a, scrollLeft };
  const t = logTimeAt(a, scrollLeft + anchorX, now);
  const axis = logAxis(T, L, w);
  return { axis, scrollLeft: logX(axis, t, now) - anchorX };
}

/** Back to Now on the log axis: the same zoom, Now LOG_NOW_AT from the left. */
export const logAxisToNow = (a: LogAxis, w: number): { axis: LogAxis; scrollLeft: number } => ({
  axis: a,
  scrollLeft: -a.uLo - LOG_NOW_AT * Math.max(1, w),
});

/* One interface over both axes. */

/** The axis kinds a Gantt switches between; log is the default. */
export type GanttScale = "log" | "linear";
export const GANTT_SCALE_DEFAULT: GanttScale = "log";

/** A time's x (px from the content's left) on either axis. */
export const scaleX = (a: GanttAxis, t: number, now: number) =>
  isLog(a) ? logX(a, t, now) : xOf(a, t);
/** The time at x on either axis. */
export const scaleTimeAt = (a: GanttAxis, x: number, now: number) =>
  isLog(a) ? logTimeAt(a, x, now) : timeAt(a, x);
/** The content's width (px) on either axis. */
export const scaleWidth = (a: GanttAxis) => (isLog(a) ? Math.round(a.uHi - a.uLo) : axisWidth(a));
/** Zoom either axis about anchorX. */
export const scaleZoom = (
  a: GanttAxis,
  scrollLeft: number,
  w: number,
  anchorX: number,
  factor: number,
  now: number,
): { axis: GanttAxis; scrollLeft: number } =>
  isLog(a)
    ? zoomLogAxis(a, scrollLeft, w, anchorX, factor, now)
    : zoomAxis(a, scrollLeft, w, anchorX, factor);
/** After a scroll or a resize: the linear axis grows (extendAxis); the log one already spans it all. */
export const scaleExtend = (
  a: GanttAxis,
  scrollLeft: number,
  w: number,
): { axis: GanttAxis; scrollLeft: number } =>
  isLog(a) ? { axis: a, scrollLeft } : extendAxis(a, scrollLeft, w);
/** Back to Now on either axis. */
export const scaleToNow = (
  a: GanttAxis,
  w: number,
  now: number,
): { axis: GanttAxis; scrollLeft: number } => (isLog(a) ? logAxisToNow(a, w) : axisToNow(a, w, now));
/** The axis on open, of the chosen kind. */
export const initialScale = (
  kind: GanttScale,
  from: number,
  to: number,
  now: number,
  w: number,
): { axis: GanttAxis; scrollLeft: number } =>
  kind === "log" ? initialLogAxis(from, to, now, w) : initialAxis(from, to, now, w);
