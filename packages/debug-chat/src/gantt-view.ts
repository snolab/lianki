/**
 * The full-screen Gantt view's axis (docs/dev-debug-widget.md, "Full-screen
 * Gantt"; owner, 2026-11-09 13:37–13:38 JST). Pure parts; GanttFull.tsx draws.
 *
 * The scales, ticks and bars live in our component library, rgui's gantt
 * module (packages/rgui/src/gantt, docs/rgui.md): the linear axis (a native
 * scroller that grows on demand, `extendAxis`, trimmed past MAX_SCREENS), the
 * symmetric-log axis around Now (`symlog`, the default), zoom about an anchor
 * on either (`scaleZoom`), readable-grid ticks (`scaleTicks`) and each task's
 * bar (`ganttBar`). They are re-exported here unchanged, so GanttFull and its
 * tests import one place. What stays here is Lianki's own: the pinch/wheel
 * input helpers and the see-through bar colours (AA-checked).
 */

import {
  type GanttAxis,
  type GanttScale,
  LOG_MAX_T,
  LOG_MIN_T,
  clamp,
  extendAxis,
  initialAxis,
  initialLogAxis,
  logAxis,
  logPxPerE,
  logX,
  xOf,
  zoomLimits,
} from "@snomiao/rgui/gantt";

export {
  CHAR_PX,
  EXTEND_SCREENS,
  GANTT_SCALE_DEFAULT,
  LOG_E_PER_SCREEN,
  LOG_MAX_L,
  LOG_MAX_T,
  LOG_MIN_L,
  LOG_MIN_T,
  LOG_NOW_AT,
  LOG_OPEN_MIN_T,
  LOG_SPAN,
  LOG_TICKS,
  MAX_SCREEN_MS,
  MAX_SCREENS,
  MIN_PX_PER_HOUR,
  MIN_SCREEN_MS,
  NOW_AT,
  TICK_GAP_PX,
  TICK_MIN_PX,
  TICK_STEPS,
  axisLabel,
  axisTicks,
  axisToNow,
  axisWidth,
  extendAxis,
  ganttBar,
  ganttRows,
  initialAxis,
  initialLogAxis,
  initialScale,
  isLog,
  labelPx,
  logAxis,
  logAxisToNow,
  logPxPerE,
  logTicks,
  logTimeAt,
  logX,
  rowsRange,
  scaleExtend,
  scaleTicks,
  scaleToNow,
  scaleWidth,
  scaleX,
  scaleZoom,
  symexp,
  symlog,
  tickMinPx,
  tickStep,
  timeAt,
  xOf,
  zoomAxis,
  zoomLimits,
  zoomLogAxis,
  type Axis,
  type GanttAxis,
  type GanttBar,
  type GanttScale,
  type LogAxis,
  type Tick,
} from "@snomiao/rgui/gantt";

/** Two touches' distance and midpoint (client px), for a pinch. */
export function pinchOf(t: ArrayLike<{ clientX: number; clientY: number }>) {
  const a = t[0]!;
  const b = t[1]!;
  return {
    dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
    cx: (a.clientX + b.clientX) / 2,
    cy: (a.clientY + b.clientY) / 2,
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

/* The default view (owner, 2026-11-10): Now centred, the soonest-ending open task centred. */

/** A row's end: when it finished (a done one), else its expected end. */
export const rowEnd = (t: { at: number; done?: boolean; doneAt?: number }) =>
  t.done && t.doneAt !== undefined ? t.doneAt : t.at;

/** The rows by end time, expected or actual, earliest first (then by start). */
export function ganttRowsByEnd<T extends { start: number; at: number; done?: boolean; doneAt?: number }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort((a, b) => rowEnd(a) - rowEnd(b) || a.start - b.start);
}

/**
 * The row the view centres on: the open task closest to ending (the soonest
 * expected end still in the future); with none, the row whose end is nearest
 * now. -1 with no rows.
 */
export function focusRow(
  rows: readonly { at: number; done?: boolean; doneAt?: number; parked?: string }[],
  now: number,
): number {
  let best = -1;
  // A parked task (waiting, blocked) is no work ending: its time is a reminder.
  rows.forEach((t, i) => {
    if (!t.done && !t.parked && t.at > now && (best < 0 || t.at < rows[best]!.at)) best = i;
  });
  if (best >= 0) return best;
  rows.forEach((t, i) => {
    if (best < 0 || Math.abs(rowEnd(t) - now) < Math.abs(rowEnd(rows[best]!) - now)) best = i;
  });
  return best;
}

/**
 * A parked row's bar (waiting for the owner, blocked): hollow and hatched, no
 * progress fill, so it never reads as work running. `line` is its edge,
 * `hatch` the stripes' colour.
 */
export const parkedBar = (hatch: string, line: string) => ({
  background: `repeating-linear-gradient(135deg, ${hatch} 0 3px, transparent 3px 7px)`,
  outline: `1px solid ${line}`,
  outlineOffset: -1,
});

/** The rows either side of the focus whose durations set the zoom (a default for the config store). */
export const GANTT_FIT_NEIGHBOURS = 3;
/** Which of those durations sets the zoom: the owner's 95th percentile (a default for the config store). */
export const GANTT_FIT_PERCENTILE = 0.95;
/** The share of the view's width that duration spans: the owner's 75% (a default for the config store). */
export const GANTT_FIT_WIDTH = 0.75;
/**
 * Blank space at the head and the tail of the row list, as a share of the
 * view's height (a default for the config store): an overscroll has room
 * before the edge, and the first or last row can still be centred.
 */
export const GANTT_END_SPACE = 0.5;

/** The `p` quantile (0–1) of `xs`, nearest rank; 0 for none. */
export function quantile(xs: readonly number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
}

/**
 * The time span the view's width holds on open: the GANTT_FIT_PERCENTILE
 * duration (start to end, expected or actual) of the focus row and its
 * GANTT_FIT_NEIGHBOURS neighbours either side, so most of their bars fit
 * on screen and none is too short. 0 when there is nothing to fit.
 */
export function fitSpan(
  rows: readonly { start: number; at: number; done?: boolean; doneAt?: number }[],
  focus: number,
  percentile = GANTT_FIT_PERCENTILE,
): number {
  if (focus < 0) return 0;
  const near = rows.slice(
    Math.max(0, focus - GANTT_FIT_NEIGHBOURS),
    focus + GANTT_FIT_NEIGHBOURS + 1,
  );
  return quantile(
    near.map((t) => rowEnd(t) - Math.min(t.start, t.at)).filter((d) => d > 0),
    percentile,
  );
}

/**
 * The view on open (and on Now): Now at the horizontal centre, past to the
 * left, future to the right, on either axis; zoomed (horizontally only) so
 * `span` spans `share` (GANTT_FIT_WIDTH) of the width — linear: span ms
 * across that share; log: a span centred on Now across it. Within each
 * axis's zoom limits; no span keeps the axis's own open zoom.
 */
export function homeView(
  kind: GanttScale,
  span: number,
  now: number,
  w: number,
  fallback: { from: number; to: number },
  share = GANTT_FIT_WIDTH,
): { axis: GanttAxis; scrollLeft: number } {
  const width = Math.max(1, w);
  const fit = width * clamp(share, 0.01, 1);
  if (kind === "log") {
    const L = logPxPerE(width);
    const T =
      span > 0
        ? clamp(span / 2 / Math.expm1(fit / 2 / L), LOG_MIN_T, LOG_MAX_T)
        : initialLogAxis(fallback.from, fallback.to, now, width).axis.T;
    const axis = logAxis(T, L, width);
    return { axis, scrollLeft: logX(axis, now, now) - width / 2 };
  }
  const lim = zoomLimits(width);
  const p =
    span > 0
      ? clamp(fit / span, lim.min, lim.max)
      : initialAxis(fallback.from, fallback.to, now, width).axis.pxPerMs;
  const screen = width / p;
  const axis = { lo: now - 3 * screen, hi: now + 3 * screen, pxPerMs: p };
  return extendAxis(axis, xOf(axis, now) - width / 2, width);
}

/** The scrollTop that puts row `i`'s middle at the middle of the rows' view (under the sticky axis). */
export function centreRowTop(d: {
  i: number;
  viewH: number;
  axisH: number;
  headSpace: number;
  rowH: number;
  rowGap: number;
}): number {
  if (d.i < 0) return 0;
  const mid = d.axisH + d.headSpace + d.i * (d.rowH + d.rowGap) + d.rowH / 2;
  const viewMid = d.axisH + (d.viewH - d.axisH) / 2;
  return Math.max(0, Math.round(mid - viewMid));
}
