/**
 * The full-screen Gantt view's axis (docs/dev-debug-widget.md, "Full-screen
 * Gantt"; owner, 2026-11-09 13:37–13:38 JST). Pure parts; GanttFull.tsx draws.
 *
 * The timeline is one native scroller: x = (t − lo) · pxPerMs, its width
 * (hi − lo) · pxPerMs. There is no hard limit: when the visible part comes
 * within a screen of either end, the range grows by EXTEND_SCREENS screens on
 * that side (`extendAxis`), and the scroll is compensated when the left side
 * grows, so nothing moves under the eye. The far side is trimmed past
 * MAX_SCREENS so the content stays bounded; the ticks are drawn only around
 * the visible part (`axisTicks`), so the DOM stays bounded too.
 *
 * Zoom (`zoomAxis`): pinch or ctrl+wheel scales pxPerMs about an anchor (the
 * pointer or the pinch centre): the time under it stays put. From
 * MIN_SCREEN_MS (minutes) to MAX_SCREEN_MS (days) per screen.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

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
/** Ticks at least this far apart (px). */
export const TICK_MIN_PX = 72;

export type Axis = { lo: number; hi: number; pxPerMs: number };

export const xOf = (a: Axis, t: number) => (t - a.lo) * a.pxPerMs;
export const timeAt = (a: Axis, x: number) => a.lo + x / a.pxPerMs;
export const axisWidth = (a: Axis) => Math.round((a.hi - a.lo) * a.pxPerMs);

/** The zoom limits for a view `w` px wide (px per ms). */
export function zoomLimits(w: number) {
  const width = Math.max(1, w);
  return { min: width / MAX_SCREEN_MS, max: width / MIN_SCREEN_MS };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

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
  // Now at NOW_AT: the latest end must fit in the rest of the screen, the earliest start before it.
  const ahead = Math.max(to - now, 0);
  const behind = Math.max(now - from, 0);
  const fit = Math.min(
    ahead > 0 ? (width * (1 - NOW_AT) * 0.9) / ahead : Infinity,
    behind > 0 ? (width * NOW_AT * 0.9) / behind : Infinity,
  );
  const floor = MIN_PX_PER_HOUR / HOUR;
  const p = clamp(Number.isFinite(fit) ? Math.max(fit, floor) : width / (2 * HOUR), lim.min, lim.max);
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
  const p = clamp(a.pxPerMs * (Number.isFinite(factor) && factor > 0 ? factor : 1), lim.min, lim.max);
  if (p === a.pxPerMs) return { axis: a, scrollLeft };
  const t = timeAt(a, scrollLeft + anchorX);
  // The left edge of the view moves so t stays at anchorX.
  const left = t - anchorX / p;
  const screen = Math.max(1, w) / p;
  const lo = Math.min(a.lo, left - screen);
  const hi = Math.max(a.hi, left + 2 * screen);
  const axis = { lo, hi, pxPerMs: p };
  return extendAxis(axis, xOf(axis, left), w);
}

/** The tick steps the axis picks from, smallest first. */
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
  7 * DAY,
];

/**
 * The smallest step at least `minPx` (TICK_MIN_PX, or more for a larger text
 * size: tickMinPx) apart at this zoom.
 */
export function tickStep(pxPerMs: number, minPx = TICK_MIN_PX): number {
  return TICK_STEPS.find((s) => s * pxPerMs >= minPx) ?? TICK_STEPS[TICK_STEPS.length - 1]!;
}

/** A label's width estimate (px) for a text whose digits are `charPx` wide, its padding included. */
export const labelPx = (label: string, charPx = CHAR_PX) => label.length * charPx + charPx;

/** The width of a digit at the axis's 12 px text (px); GanttFull passes the measured one. */
export const CHAR_PX = 8;
/** The clear space between two tick labels (px). */
export const TICK_GAP_PX = 10;
/** The longest linear label ("-13.5D") never meets its neighbour: the step is at least this far apart. */
export const tickMinPx = (charPx = CHAR_PX) => Math.max(TICK_MIN_PX, labelPx("-13.5D", charPx) + TICK_GAP_PX);

/**
 * A tick's label, relative to now, language-neutral like compactTime: "Now",
 * "30M", "-30M", "2H", "1.5H", "-6H", "1D", "-2D". Minutes under an hour,
 * hours (one decimal) under a day, days (one decimal) from a day.
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
 * The ticks around the view (a screen either side), on whole steps from now,
 * so the labels are round ("-1H", "Now", "1H"). Bounded: at most a few
 * screens' worth, whatever the range.
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

/** Two touches' distance and centre (clientX), for a pinch. */
export function pinchOf(t: ArrayLike<{ clientX: number; clientY: number }>) {
  const a = t[0]!;
  const b = t[1]!;
  return {
    dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
    cx: (a.clientX + b.clientX) / 2,
  };
}

/** A ctrl+wheel (trackpad pinch) step's zoom factor: up (negative deltaY) zooms in. */
export const wheelFactor = (deltaY: number) => Math.exp(clamp(-deltaY, -100, 100) * 0.01);

/* Colours: the bars are see-through (owner, 2026-11-09 13:38 JST). */

/** An oklch colour, its alpha 1 when opaque. */
export type Oklch = { l: number; c: number; h: number; a: number };

export function parseOklch(css: string): Oklch {
  const m = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)$/.exec(css);
  if (!m) throw new Error(`not an oklch(): ${css}`);
  return { l: +m[1]!, c: +m[2]!, h: +m[3]!, a: m[4] === undefined ? 1 : +m[4] };
}

/** oklch → gamma-encoded sRGB (0–1), clamped into the gamut. */
export function oklchToSrgb({ l, c, h }: Oklch): [number, number, number] {
  const hr = (h * Math.PI) / 180;
  const A = c * Math.cos(hr);
  const B = c * Math.sin(hr);
  const l_ = (l + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m_ = (l - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s_ = (l - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const lin = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  const enc = (v: number) => {
    const x = clamp(v, 0, 1);
    return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  };
  return [enc(lin[0]!), enc(lin[1]!), enc(lin[2]!)];
}

/** Paint `top` (with its alpha) over the opaque `under` (sRGB), as a browser composites. */
export function over(top: Oklch, under: [number, number, number]): [number, number, number] {
  const t = oklchToSrgb(top);
  return [0, 1, 2].map((i) => t[i]! * top.a + under[i]! * (1 - top.a)) as [number, number, number];
}

/** WCAG relative luminance of a gamma-encoded sRGB colour. */
export function srgbLuminance([r, g, b]: [number, number, number]): number {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * The full-screen Gantt's colours (owner, 2026-11-09 13:38 JST): a row's bar
 * is its background, see-through so the grid and the red Now line show
 * through it; the planned part `bar` (a queued one `queued`, fainter), the
 * progress `fill` over it, the overrun `past`, a done one `done`. `text`,
 * `muted` and `late` are WCAG AA (4.5:1) over each of them composited on the
 * panel's `track` (unit/gantt-view.test.ts composites and checks).
 */
export const GANTT_COLORS = {
  light: {
    text: "oklch(0.27 0.02 260)",
    muted: "oklch(0.42 0.02 260)",
    late: "oklch(0.46 0.18 27)",
    track: "oklch(0.985 0.004 260)",
    grid: "oklch(0.9 0.01 260)",
    bar: "oklch(0.62 0.13 250 / 0.22)",
    queued: "oklch(0.62 0.13 250 / 0.1)",
    fill: "oklch(0.6 0.15 250 / 0.2)",
    past: "oklch(0.63 0.2 25 / 0.24)",
    done: "oklch(0.66 0.15 150 / 0.28)",
  },
  dark: {
    text: "oklch(0.95 0.01 260)",
    muted: "oklch(0.82 0.01 260)",
    late: "oklch(0.82 0.11 25)",
    track: "oklch(0.19 0.01 260)",
    grid: "oklch(0.3 0.01 260)",
    bar: "oklch(0.68 0.12 250 / 0.24)",
    queued: "oklch(0.68 0.12 250 / 0.12)",
    fill: "oklch(0.7 0.14 250 / 0.18)",
    past: "oklch(0.66 0.18 25 / 0.3)",
    done: "oklch(0.7 0.14 150 / 0.26)",
  },
} as const;

export const ganttColor = (k: keyof (typeof GANTT_COLORS)["light"]) =>
  `light-dark(${GANTT_COLORS.light[k]}, ${GANTT_COLORS.dark[k]})`;

/** A Gantt row, in px on the axis: the planned bar, its progress, the overrun. */
export type GanttBar = {
  x: number;
  w: number;
  /** The progress fill, px from the bar's start. */
  fill: number;
  /** The overrun past the estimate: from x + w, this wide. */
  over: number;
};

/**
 * One task's bar on the axis (px), clamped to the content [0, width]: from
 * its start to its estimate, the progress (pct; a done one all of it) inside,
 * past the estimate the overrun on to now (or to when it finished late).
 */
export function ganttBar(
  t: { start: number; at: number; pct?: number; done?: boolean; doneAt?: number },
  a: GanttAxis,
  now: number,
): GanttBar {
  const width = scaleWidth(a);
  // Each end projected on its own (on the log axis a bar is not a shifted copy).
  const x = (ms: number) => clamp(scaleX(a, ms, now), 0, width);
  const x0 = x(Math.min(t.start, t.at));
  const x1 = x(t.at);
  const end = t.done ? x(t.doneAt ?? t.at) : x(now);
  const pct = t.done ? 100 : clamp(t.pct ?? 0, 0, 100);
  const w = x1 - x0;
  return { x: x0, w, fill: (w * pct) / 100, over: Math.max(0, end - x1) };
}

/**
 * The full view's rows: every timed task the tree has, done ones too (the
 * history the axis scrolls back into). Open ones first, as the Gantt plans
 * them (queued after the running, ganttPlan), by start; then the done, the
 * latest finished first.
 */
export function ganttRows<T extends { start: number; done?: boolean; doneAt?: number; at: number }>(
  planned: readonly T[],
): T[] {
  const open = planned.filter((t) => !t.done).sort((a, b) => a.start - b.start || a.at - b.at);
  const done = planned
    .filter((t) => t.done)
    .sort((a, b) => (b.doneAt ?? b.at) - (a.doneAt ?? a.at));
  return [...open, ...done];
}

/** The tasks' time range (earliest start, latest end), or now..now with none. */
export function rowsRange(
  rows: readonly { start: number; at: number; done?: boolean; doneAt?: number }[],
  now: number,
): { from: number; to: number } {
  if (!rows.length) return { from: now, to: now };
  return {
    from: Math.min(...rows.map((t) => Math.min(t.start, t.at))),
    to: Math.max(...rows.map((t) => (t.done && t.doneAt !== undefined ? t.doneAt : t.at))),
  };
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


/* The logarithmic axis (owner, 2026-11-09 15:27 JST): the default. */

/**
 * A symmetric-log axis around Now: a time t is drawn at
 *
 *   u = sign(dt) · L · ln(1 + |dt| / T),   dt = t − now,
 *
 * px from the Now line (`symlog`; `symexp` is its inverse). Within about T of
 * Now it is linear (L / T px per ms), further out every e-fold of distance
 * takes the same L px, so minutes and days fit one screen. The content spans
 * LOG_SPAN either side of Now: x = u − uLo, its width uHi − uLo, bounded
 * (some 20 e-folds a side) however far it reaches, so there is no growing or
 * trimming as on the linear axis; the ticks are drawn only around the view.
 * Now stays at the same x while time passes: the bars move, not the axis.
 *
 * Zoom (`zoomLogAxis`) spreads the e-folds (L × √f) and narrows the linear
 * window (T ÷ √f) together: near Now the scale changes by f, far out by √f,
 * and the time under the fingers stays put.
 */
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
export const logTimeAt = (a: LogAxis, x: number, now: number) => now + symexp(x + a.uLo, a.T, a.L);

/** Px per e-fold on open for a view `w` px wide. */
export const logPxPerE = (w: number) => clamp(Math.max(1, w) / LOG_E_PER_SCREEN, LOG_MIN_L, LOG_MAX_L);

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
    Math.max(fit(to - now, (1 - LOG_NOW_AT) * width), fit(now - from, LOG_NOW_AT * width), LOG_OPEN_MIN_T),
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

/* One interface over both axes, for GanttFull. */

/** A time's x (px from the content's left) on either axis. */
export const scaleX = (a: GanttAxis, t: number, now: number) =>
  isLog(a) ? logX(a, t, now) : xOf(a, t);
/** The content's width (px) on either axis. */
export const scaleWidth = (a: GanttAxis) => (isLog(a) ? Math.round(a.uHi - a.uLo) : axisWidth(a));
/** The ticks around the view on either axis. */
export const scaleTicks = (a: GanttAxis, scrollLeft: number, w: number, now: number, charPx = CHAR_PX) =>
  isLog(a) ? logTicks(a, scrollLeft, w, now, charPx) : axisTicks(a, scrollLeft, w, now, charPx);
/** Zoom either axis about anchorX. */
export const scaleZoom = (
  a: GanttAxis,
  scrollLeft: number,
  w: number,
  anchorX: number,
  factor: number,
  now: number,
): { axis: GanttAxis; scrollLeft: number } =>
  isLog(a) ? zoomLogAxis(a, scrollLeft, w, anchorX, factor, now) : zoomAxis(a, scrollLeft, w, anchorX, factor);
/** After a scroll or a resize: the linear axis grows (extendAxis); the log one already spans it all. */
export const scaleExtend = (
  a: GanttAxis,
  scrollLeft: number,
  w: number,
): { axis: GanttAxis; scrollLeft: number } =>
  isLog(a) ? { axis: a, scrollLeft } : extendAxis(a, scrollLeft, w);
/** Back to Now on either axis. */
export const scaleToNow = (a: GanttAxis, w: number, now: number): { axis: GanttAxis; scrollLeft: number } =>
  isLog(a) ? logAxisToNow(a, w) : axisToNow(a, w, now);
/** The axis on open, of the chosen kind. */
export const initialScale = (
  kind: GanttScale,
  from: number,
  to: number,
  now: number,
  w: number,
): { axis: GanttAxis; scrollLeft: number } =>
  kind === "log" ? initialLogAxis(from, to, now, w) : initialAxis(from, to, now, w);

/** The axis kinds the toggle switches between; log is the default (owner, 15:27 JST). */
export type GanttScale = "log" | "linear";
export const GANTT_SCALE_DEFAULT: GanttScale = "log";
