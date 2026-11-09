import { describe, expect, it } from "bun:test";
import {
  type Axis,
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
  TICK_GAP_PX,
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
  scaleExtend,
  scaleTicks,
  scaleToNow,
  scaleWidth,
  scaleX,
  scaleZoom,
  symexp,
  symlog,
  tickMinPx,
  zoomLogAxis,
  GANTT_COLORS,
  MAX_SCREENS,
  MAX_SCREEN_MS,
  MIN_PX_PER_HOUR,
  MIN_SCREEN_MS,
  NOW_AT,
  TICK_MIN_PX,
  TICK_STEPS,
  axisLabel,
  axisTicks,
  axisToNow,
  axisWidth,
  extendAxis,
  ganttBar,
  ganttColor,
  ganttRows,
  initialAxis,
  oklchToSrgb,
  over,
  parseOklch,
  pinchOf,
  rowsRange,
  srgbLuminance,
  tickStep,
  timeAt,
  wheelFactor,
  xOf,
  zoomAxis,
  zoomLimits,
} from "@lianki/debug-chat/gantt-view";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-09T05:30:00Z");
const W = 1200;

describe("the axis on open", () => {
  it("puts now a quarter from the left and fits a short range", () => {
    const { axis, scrollLeft } = initialAxis(NOW - 20 * MIN, NOW + 40 * MIN, NOW, W);
    expect(xOf(axis, NOW) - scrollLeft).toBeCloseTo(NOW_AT * W);
    // The latest end and the earliest start are both on the first screen.
    expect(xOf(axis, NOW + 40 * MIN) - scrollLeft).toBeLessThanOrEqual(W);
    expect(xOf(axis, NOW - 20 * MIN) - scrollLeft).toBeGreaterThanOrEqual(0);
    // A screen of margin beyond the tasks and now on each side.
    expect(axis.lo).toBeLessThan(timeAt(axis, scrollLeft));
    expect(axis.hi).toBeGreaterThan(timeAt(axis, scrollLeft + W));
    expect(axisWidth(axis)).toBeGreaterThan(W);
  });

  it("a long range scrolls instead of squashing: at least MIN_PX_PER_HOUR", () => {
    const { axis } = initialAxis(NOW - 3 * DAY, NOW + 5 * DAY, NOW, W);
    expect(axis.pxPerMs * HOUR).toBeCloseTo(MIN_PX_PER_HOUR);
    expect(axisWidth(axis)).toBeGreaterThan(5 * W);
  });

  it("no tasks: two hours across, within the zoom limits", () => {
    const { axis } = initialAxis(NOW, NOW, NOW, W);
    expect(axis.pxPerMs).toBeCloseTo(W / (2 * HOUR));
    const tiny = initialAxis(NOW, NOW + 1000, NOW, W).axis;
    expect(tiny.pxPerMs).toBeCloseTo(zoomLimits(W).max);
    // A zero-width view is treated as 1 px.
    expect(initialAxis(NOW, NOW, NOW, 0).axis.pxPerMs).toBeGreaterThan(0);
  });

  it("zoom limits: minutes to days per screen", () => {
    const l = zoomLimits(W);
    expect(W / l.max).toBe(MIN_SCREEN_MS);
    expect(W / l.min).toBe(MAX_SCREEN_MS);
    expect(zoomLimits(0).max).toBe(1 / MIN_SCREEN_MS);
  });
});

describe("free scrolling: the axis grows on both sides", () => {
  const a: Axis = { lo: NOW - 2 * HOUR, hi: NOW + 2 * HOUR, pxPerMs: W / HOUR };
  it("nothing to do in the middle (same object back)", () => {
    const s = xOf(a, NOW - 30 * MIN);
    const r = extendAxis(a, s, W);
    expect(r.axis).toBe(a);
    expect(r.scrollLeft).toBe(s);
  });

  it("near the left end it grows left and compensates scrollLeft", () => {
    const s = xOf(a, NOW - 1.5 * HOUR);
    const before = timeAt(a, s);
    const r = extendAxis(a, s, W);
    expect(r.axis.lo).toBeLessThan(a.lo);
    expect(r.axis.lo).toBeCloseTo(before - (EXTEND_SCREENS + 1) * HOUR);
    // The same time stays at the view's left edge.
    expect(timeAt(r.axis, r.scrollLeft)).toBeCloseTo(before);
    expect(r.axis.hi).toBe(a.hi);
  });

  it("near the right end it grows right; scrollLeft unchanged", () => {
    const s = xOf(a, NOW + 0.5 * HOUR);
    const r = extendAxis(a, s, W);
    expect(r.axis.hi).toBeGreaterThan(a.hi);
    expect(r.axis.lo).toBe(a.lo);
    expect(r.scrollLeft).toBeCloseTo(s);
  });

  it("stays bounded: past MAX_SCREENS the far side is trimmed", () => {
    // Panning left again and again: the right side is dropped.
    let v = { axis: a, scrollLeft: 0 };
    for (let i = 0; i < 20; i++) v = extendAxis(v.axis, 0, W);
    expect(v.axis.hi - v.axis.lo).toBeLessThanOrEqual(MAX_SCREENS * HOUR + 1);
    expect(v.axis.lo).toBeLessThan(a.lo - 20 * HOUR);
    // And to the right: the left side is dropped, the view's time kept.
    let r = { axis: a, scrollLeft: axisWidth(a) - W };
    for (let i = 0; i < 20; i++) {
      const at = timeAt(r.axis, axisWidth(r.axis) - W);
      r = extendAxis(r.axis, axisWidth(r.axis) - W, W);
      expect(timeAt(r.axis, r.scrollLeft)).toBeCloseTo(at, -1);
    }
    expect(r.axis.hi - r.axis.lo).toBeLessThanOrEqual(MAX_SCREENS * HOUR + 1);
    expect(r.axis.hi).toBeGreaterThan(a.hi + 20 * HOUR);
    // A range already too wide (no end near): trimmed around the view.
    const wide: Axis = { lo: NOW - 50 * HOUR, hi: NOW + 50 * HOUR, pxPerMs: W / HOUR };
    const t = extendAxis(wide, xOf(wide, NOW), W);
    expect(t.axis.hi - t.axis.lo).toBeLessThanOrEqual((MAX_SCREENS + 1) * HOUR);
    expect(timeAt(t.axis, t.scrollLeft)).toBeCloseTo(NOW, -1);
  });
});

describe("pinch zoom keeps the time under the fingers", () => {
  const a: Axis = { lo: NOW - 6 * HOUR, hi: NOW + 6 * HOUR, pxPerMs: W / (2 * HOUR) };
  const s = xOf(a, NOW - HOUR);
  for (const factor of [2, 0.5, 1.3, 0.1])
    it(`factor ${factor}: the anchored time stays at the anchor`, () => {
      const anchor = 300;
      const t = timeAt(a, s + anchor);
      const r = zoomAxis(a, s, W, anchor, factor);
      expect(timeAt(r.axis, r.scrollLeft + anchor)).toBeCloseTo(t, -1);
      // The view is inside the content.
      expect(r.scrollLeft).toBeGreaterThanOrEqual(0);
      expect(r.scrollLeft + W).toBeLessThanOrEqual(axisWidth(r.axis) + 1);
    });

  it("clamped to the limits; a no-op at a limit or with a bad factor", () => {
    const l = zoomLimits(W);
    const r = zoomAxis(a, s, W, 0, 1e9);
    expect(r.axis.pxPerMs).toBe(l.max);
    expect(zoomAxis(r.axis, r.scrollLeft, W, 0, 2).axis).toBe(r.axis);
    const out = zoomAxis(a, s, W, 0, 1e-9);
    expect(out.axis.pxPerMs).toBe(l.min);
    expect(zoomAxis(a, s, W, 0, Number.NaN).axis).toBe(a);
    expect(zoomAxis(a, s, W, 0, -1).axis).toBe(a);
  });

  it("zooming far in keeps the content bounded", () => {
    const r = zoomAxis(a, s, W, 600, 1e9);
    expect(axisWidth(r.axis)).toBeLessThanOrEqual((MAX_SCREENS + 1) * W);
  });

  it("pinch geometry and the wheel's factor", () => {
    const p = pinchOf([
      { clientX: 100, clientY: 0 },
      { clientX: 400, clientY: 400 },
    ]);
    expect(p.dist).toBe(500);
    expect(p.cx).toBe(250);
    expect(wheelFactor(-10)).toBeGreaterThan(1);
    expect(wheelFactor(10)).toBeLessThan(1);
    expect(wheelFactor(0)).toBe(1);
    expect(wheelFactor(-1e6)).toBeCloseTo(Math.E);
  });
});

describe("axis ticks re-tick as it zooms", () => {
  it("labels: Now, M under an hour, H under a day, D beyond; negative in the past", () => {
    expect(axisLabel(0)).toBe("Now");
    expect(axisLabel(10_000)).toBe("Now");
    expect(axisLabel(30 * MIN)).toBe("30M");
    expect(axisLabel(-15 * MIN)).toBe("-15M");
    expect(axisLabel(2 * HOUR)).toBe("2H");
    expect(axisLabel(-1.5 * HOUR)).toBe("-1.5H");
    expect(axisLabel(DAY)).toBe("1D");
    expect(axisLabel(-2.5 * DAY)).toBe("-2.5D");
  });

  it("the step is the smallest at least TICK_MIN_PX apart", () => {
    expect(tickStep(W / (10 * MIN))).toBe(MIN);
    expect(tickStep(W / (2 * HOUR))).toBe(10 * MIN);
    expect(tickStep(W / (3 * DAY))).toBe(6 * HOUR);
    expect(tickStep(1e-12)).toBe(TICK_STEPS[TICK_STEPS.length - 1]);
    for (const p of [W / HOUR, W / DAY, W / (14 * DAY)])
      expect(tickStep(p) * p).toBeGreaterThanOrEqual(TICK_MIN_PX);
  });

  it("ticks sit on whole steps from now, around the view only", () => {
    const { axis, scrollLeft } = initialAxis(NOW - HOUR, NOW + HOUR, NOW, W);
    const ticks = axisTicks(axis, scrollLeft, W, NOW);
    const step = tickStep(axis.pxPerMs);
    expect(ticks.some((t) => t.now && t.label === "Now")).toBe(true);
    for (const t of ticks) {
      expect(Math.abs((t.t - NOW) % step)).toBe(0);
      expect(t.x).toBeCloseTo(xOf(axis, t.t));
      expect(t.x).toBeGreaterThanOrEqual(scrollLeft - W - 1);
      expect(t.x).toBeLessThanOrEqual(scrollLeft + 2 * W + 1);
    }
    // Bounded whatever the range: about three screens of ticks.
    expect(ticks.length).toBeLessThanOrEqual(Math.ceil((3 * W) / TICK_MIN_PX) + 1);
  });
});

describe("rows and bars", () => {
  const a: Axis = { lo: NOW - 2 * HOUR, hi: NOW + 2 * HOUR, pxPerMs: W / HOUR };
  it("a running bar: start to estimate, its progress inside", () => {
    const b = ganttBar({ start: NOW - 30 * MIN, at: NOW + 30 * MIN, pct: 50 }, a, NOW);
    expect(b.x).toBeCloseTo(xOf(a, NOW - 30 * MIN));
    expect(b.w).toBeCloseTo(W);
    expect(b.fill).toBeCloseTo(W / 2);
    expect(b.over).toBe(0);
  });
  it("overdue: the overrun runs on to now; done late, to when it finished", () => {
    const late = ganttBar({ start: NOW - HOUR, at: NOW - 30 * MIN }, a, NOW);
    expect(late.over).toBeCloseTo(W / 2);
    expect(late.fill).toBe(0);
    const done = ganttBar(
      { start: NOW - HOUR, at: NOW - 30 * MIN, done: true, doneAt: NOW - 15 * MIN },
      a,
      NOW,
    );
    expect(done.fill).toBeCloseTo(done.w);
    expect(done.over).toBeCloseTo(W / 4);
    // Done without doneAt: no overrun. pct out of range is clamped.
    expect(ganttBar({ start: NOW - HOUR, at: NOW, done: true }, a, NOW).over).toBe(0);
    expect(ganttBar({ start: NOW - HOUR, at: NOW, pct: 300 }, a, NOW).fill).toBeCloseTo(W);
  });
  it("clamped to the content", () => {
    const b = ganttBar({ start: NOW - 10 * HOUR, at: NOW + 10 * HOUR }, a, NOW);
    expect(b.x).toBe(0);
    expect(b.w).toBe(axisWidth(a));
  });
  it("rows: open by start first, then done, the latest finished first", () => {
    const rows = ganttRows([
      { id: "d1", start: 0, at: 5, done: true, doneAt: 6 },
      { id: "o2", start: 10, at: 20 },
      { id: "d2", start: 0, at: 5, done: true, doneAt: 9 },
      { id: "o1", start: 5, at: 30 },
      { id: "o3", start: 10, at: 15 },
      { id: "d3", start: 0, at: 4, done: true },
    ]);
    expect(rows.map((r) => r.id)).toEqual(["o1", "o3", "o2", "d2", "d1", "d3"]);
  });
  it("the range: earliest start to latest end; now..now with none", () => {
    expect(rowsRange([], NOW)).toEqual({ from: NOW, to: NOW });
    expect(
      rowsRange(
        [
          { start: 10, at: 50 },
          { start: 5, at: 8, done: true, doneAt: 70 },
          { start: 30, at: 20 },
        ],
        NOW,
      ),
    ).toEqual({ from: 5, to: 70 });
  });
});

describe("the Now button", () => {
  const a: Axis = { lo: NOW - 30 * HOUR, hi: NOW - 20 * HOUR, pxPerMs: W / HOUR };
  it("near: grows the range to now, now a quarter from the left", () => {
    const near: Axis = { lo: NOW - 6 * HOUR, hi: NOW - 2 * HOUR, pxPerMs: W / HOUR };
    const r = axisToNow(near, W, NOW);
    expect(xOf(r.axis, NOW) - r.scrollLeft).toBeCloseTo(NOW_AT * W);
    expect(r.axis.pxPerMs).toBe(near.pxPerMs);
  });
  it("far: rebuilt around now", () => {
    const far: Axis = { lo: NOW - 300 * HOUR, hi: NOW - 290 * HOUR, pxPerMs: W / HOUR };
    const r = axisToNow(far, W, NOW);
    expect(xOf(r.axis, NOW) - r.scrollLeft).toBeCloseTo(NOW_AT * W);
    expect(r.axis.lo).toBeGreaterThan(NOW - 10 * HOUR);
    expect(axisToNow(a, 0, NOW).axis.pxPerMs).toBe(a.pxPerMs);
  });
});

describe("see-through bars keep the text readable (AA, composited)", () => {
  const cr = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  for (const theme of ["light", "dark"] as const)
    it(`${theme}: text, muted and late are 4.5:1 over every bar on the track`, () => {
      const c = GANTT_COLORS[theme];
      const track = oklchToSrgb(parseOklch(c.track));
      const bar = over(parseOklch(c.bar), track);
      const bgs = [
        track,
        bar,
        over(parseOklch(c.fill), bar),
        over(parseOklch(c.past), track),
        over(parseOklch(c.done), track),
        over(parseOklch(c.queued), track),
      ];
      for (const bg of bgs)
        for (const fg of [c.text, c.muted, c.late])
          expect(
            cr(srgbLuminance(oklchToSrgb(parseOklch(fg))), srgbLuminance(bg)),
          ).toBeGreaterThanOrEqual(4.5);
      // The bars show against the track; the red Now line too.
      for (const bg of bgs.slice(1))
        expect(cr(srgbLuminance(bg), srgbLuminance(track))).toBeGreaterThan(1.05);
      expect(
        cr(srgbLuminance(oklchToSrgb(parseOklch(c.late))), srgbLuminance(track)),
      ).toBeGreaterThan(3);
      // Every colour is oklch.
      for (const v of Object.values(c)) expect(v).toMatch(/^oklch\(/);
    });

  it("parsing and the light-dark pair", () => {
    expect(parseOklch("oklch(0.5 0.1 200)")).toEqual({ l: 0.5, c: 0.1, h: 200, a: 1 });
    expect(parseOklch("oklch(0.5 0.1 200 / 0.3)").a).toBe(0.3);
    expect(() => parseOklch("#fff")).toThrow();
    expect(ganttColor("bar")).toBe(
      `light-dark(${GANTT_COLORS.light.bar}, ${GANTT_COLORS.dark.bar})`,
    );
    // White and black, end to end.
    expect(srgbLuminance(oklchToSrgb(parseOklch("oklch(1 0 0)")))).toBeCloseTo(1, 3);
    expect(srgbLuminance(oklchToSrgb(parseOklch("oklch(0 0 0)")))).toBe(0);
  });
});

/* The logarithmic axis (owner, 2026-11-09 15:27 JST). */

const LOG_WS = [360, 390, 1200, 1440];
const LOG_TS = [LOG_MIN_T, 5 * MIN, HOUR, DAY, LOG_MAX_T];
const LOG_LS = [LOG_MIN_L, 48, 120, LOG_MAX_L];
const DTS = [
  0,
  1,
  999,
  30_000,
  MIN,
  7 * MIN,
  HOUR,
  5.5 * HOUR,
  DAY,
  9 * DAY,
  400 * DAY,
  LOG_SPAN / 3,
  LOG_SPAN,
];

describe("symlog: the transform around Now", () => {
  it("is odd (symmetric about Now) and zero at Now", () => {
    for (const T of LOG_TS)
      for (const L of LOG_LS)
        for (const dt of DTS) {
          expect(symlog(-dt, T, L)).toBeCloseTo(-symlog(dt, T, L), 6);
          const u = symlog(dt, T, L);
          expect(symexp(-u, T, L)).toBe(-symexp(u, T, L));
        }
    expect(symlog(0, MIN, 100)).toBe(0);
    expect(symexp(0, MIN, 100)).toBe(0);
  });
  it("is strictly increasing, and so is its inverse", () => {
    const sorted = [
      ...DTS.slice(1)
        .map((d) => -d)
        .reverse(),
      ...DTS,
    ];
    for (const T of LOG_TS)
      for (const L of LOG_LS) {
        const us = sorted.map((d) => symlog(d, T, L));
        for (let i = 1; i < us.length; i++) expect(us[i]!).toBeGreaterThan(us[i - 1]!);
        const back = [-5000, -100, -1, 0, 1, 100, 5000].map((u) => symexp(u, T, L));
        for (let i = 1; i < back.length; i++) expect(back[i]!).toBeGreaterThan(back[i - 1]!);
      }
  });
  it("inverse(forward(t)) == t, to a part in 1e9 of the distance", () => {
    for (const T of LOG_TS)
      for (const L of LOG_LS)
        for (const dt of DTS)
          for (const s of [-1, 1]) {
            const back = symexp(symlog(s * dt, T, L), T, L);
            expect(Math.abs(back - s * dt)).toBeLessThanOrEqual(Math.max(1e-6, dt * 1e-9));
          }
  });
  it("near Now it is linear (L / T px per ms); far out each e-fold takes L px", () => {
    const T = HOUR;
    const L = 100;
    expect(symlog(1000, T, L) / 1000 / (L / T)).toBeCloseTo(1, 3);
    const far = symlog(1000 * DAY * Math.E, T, L) - symlog(1000 * DAY, T, L);
    expect(far).toBeCloseTo(L, 1);
  });
});

describe("the log axis: x and its inverse", () => {
  it("logX and logTimeAt are inverses within the span, either side of Now", () => {
    for (const w of LOG_WS)
      for (const T of LOG_TS) {
        const a = logAxis(T, logPxPerE(w), w);
        for (const dt of DTS)
          for (const s of [-1, 1]) {
            const t = NOW + s * dt;
            const back = logTimeAt(a, logX(a, t, NOW), NOW);
            expect(Math.abs(back - t)).toBeLessThanOrEqual(Math.max(1e-3, dt * 1e-9));
          }
      }
  });
  it("Now is at -uLo, mirrored: the content is symmetric about it", () => {
    const a = logAxis(5 * MIN, 100, 1200);
    expect(logX(a, NOW, NOW)).toBeCloseTo(-a.uLo);
    expect(a.uHi).toBeCloseTo(-a.uLo);
    expect(logX(a, NOW + HOUR, NOW) - logX(a, NOW, NOW)).toBeCloseTo(
      logX(a, NOW, NOW) - logX(a, NOW - HOUR, NOW),
    );
    expect(scaleWidth(a)).toBe(Math.round(a.uHi - a.uLo));
  });
  it("past the span it stays at the ends; a short span still gives a screen a side", () => {
    const a = logAxis(LOG_MAX_T, LOG_MIN_L, 1440);
    expect(a.uHi).toBe(1440);
    expect(logX(a, NOW + 10 * LOG_SPAN, NOW)).toBeCloseTo(logX(a, NOW + LOG_SPAN, NOW));
    expect(logX(a, NOW - 10 * LOG_SPAN, NOW)).toBeCloseTo(logX(a, NOW - LOG_SPAN, NOW));
    expect(logAxis(MIN, 100).uHi).toBeCloseTo(symlog(LOG_SPAN, MIN, 100));
  });
  it("bounded: a thousand years a side is a few screens", () => {
    for (const w of LOG_WS) {
      const a = logAxis(LOG_MIN_T, logPxPerE(w), w);
      expect(scaleWidth(a)).toBeLessThan(12 * w);
    }
  });
  it("px per e-fold on open: about LOG_E_PER_SCREEN a screen, within the limits", () => {
    expect(logPxPerE(1200)).toBe(1200 / LOG_E_PER_SCREEN);
    expect(logPxPerE(100)).toBe(LOG_MIN_L);
    expect(logPxPerE(10_000)).toBe(LOG_MAX_L);
    expect(logPxPerE(0)).toBe(LOG_MIN_L);
  });
});

describe("the log axis on open", () => {
  it("Now a third from the left; minute and day tasks on one screen", () => {
    for (const w of LOG_WS) {
      const from = NOW - 3 * HOUR;
      const to = NOW + 9 * HOUR;
      const { axis, scrollLeft } = initialLogAxis(from, to, NOW, w);
      expect(logX(axis, NOW, NOW) - scrollLeft).toBeCloseTo(LOG_NOW_AT * w);
      expect(logX(axis, to, NOW) - scrollLeft).toBeLessThanOrEqual(w);
      expect(logX(axis, from, NOW) - scrollLeft).toBeGreaterThanOrEqual(0);
      // A 10-minute task near Now is still wider than a sliver.
      expect(logX(axis, NOW + 10 * MIN, NOW) - logX(axis, NOW, NOW)).toBeGreaterThan(15);
    }
  });
  it("the window: never under LOG_OPEN_MIN_T, never past LOG_MAX_T; no tasks is fine", () => {
    expect(initialLogAxis(NOW, NOW + MIN, NOW, 1200).axis.T).toBe(LOG_OPEN_MIN_T);
    expect(initialLogAxis(NOW, NOW, NOW, 1200).axis.T).toBe(LOG_OPEN_MIN_T);
    expect(initialLogAxis(NOW - LOG_SPAN, NOW + LOG_SPAN, NOW, 360).axis.T).toBe(LOG_MAX_T);
    expect(initialLogAxis(NOW, NOW, NOW, 0).axis.L).toBe(LOG_MIN_L);
  });
  it("initialScale picks the kind", () => {
    expect(isLog(initialScale("log", NOW - HOUR, NOW + HOUR, NOW, W).axis)).toBe(true);
    expect(isLog(initialScale("linear", NOW - HOUR, NOW + HOUR, NOW, W).axis)).toBe(false);
    expect(GANTT_SCALE_DEFAULT).toBe("log");
  });
});

describe("log zoom keeps the time under the fingers", () => {
  it("anchor invariance at Now and either side, in and out", () => {
    for (const w of [390, 1440]) {
      const open = initialLogAxis(NOW - 3 * HOUR, NOW + 9 * HOUR, NOW, w);
      for (const anchorX of [0, w / 5, LOG_NOW_AT * w, (2 * w) / 3, w])
        for (const f of [1.3, 0.7, 2, 0.5]) {
          const t = logTimeAt(open.axis, open.scrollLeft + anchorX, NOW);
          const z = zoomLogAxis(open.axis, open.scrollLeft, w, anchorX, f, NOW);
          expect(logX(z.axis, t, NOW) - z.scrollLeft).toBeCloseTo(anchorX, 4);
        }
    }
  });
  it("in: the e-folds spread and the window narrows (√f each); out: the reverse", () => {
    const a = logAxis(HOUR, 100, W);
    const z = zoomLogAxis(a, 500, W, 300, 4, NOW).axis;
    expect(z.L).toBeCloseTo(200);
    expect(z.T).toBeCloseTo(HOUR / 2);
    const o = zoomLogAxis(a, 500, W, 300, 1 / 4, NOW).axis;
    expect(o.L).toBeCloseTo(50);
    expect(o.T).toBeCloseTo(2 * HOUR);
  });
  it("at both limits nothing changes (the same object); a bad factor is no zoom", () => {
    const inMost = logAxis(LOG_MIN_T, LOG_MAX_L, W);
    expect(zoomLogAxis(inMost, 100, W, 50, 3, NOW).axis).toBe(inMost);
    const outMost = logAxis(LOG_MAX_T, LOG_MIN_L, W);
    expect(zoomLogAxis(outMost, 100, W, 50, 0.2, NOW).axis).toBe(outMost);
    const a = logAxis(HOUR, 100, W);
    for (const bad of [0, -2, Number.NaN, Infinity])
      expect(zoomLogAxis(a, 100, W, 50, bad, NOW)).toEqual({ axis: a, scrollLeft: 100 });
  });
  it("one limit reached, the other still moves", () => {
    const a = logAxis(LOG_MIN_T, 100, W);
    const z = zoomLogAxis(a, 400, W, 200, 4, NOW).axis;
    expect(z.T).toBe(LOG_MIN_T);
    expect(z.L).toBeCloseTo(200);
  });
});

describe("log ticks: round M/H/D distances that never overlap", () => {
  const noOverlap = (ticks: { x: number; label: string }[], charPx = CHAR_PX) => {
    const b = ticks.map((k) => ({
      l: k.x - labelPx(k.label, charPx) / 2,
      r: k.x + labelPx(k.label, charPx) / 2,
    }));
    for (let i = 1; i < b.length; i++)
      expect(b[i]!.l - b[i - 1]!.r).toBeGreaterThanOrEqual(TICK_GAP_PX - 1e-6);
  };
  it("at every zoom and width: Now labelled, sorted, apart, round", () => {
    for (const w of LOG_WS)
      for (const T of LOG_TS)
        for (const L of LOG_LS)
          for (const charPx of [CHAR_PX, 12]) {
            const a = logAxis(T, L, w);
            const sl = -a.uLo - LOG_NOW_AT * w;
            const ticks = logTicks(a, sl, w, NOW, charPx);
            expect(ticks.filter((k) => k.now).map((k) => k.label)).toEqual(["Now"]);
            noOverlap(ticks, charPx);
            for (const k of ticks) {
              expect(k.x).toBeCloseTo(logX(a, k.t, NOW), 6);
              expect(k.label).toMatch(/^(Now|-?\d+(\.\d)?[MHD])$/);
              if (!k.now) expect(LOG_TICKS).toContain(Math.abs(k.t - NOW));
            }
          }
  });
  it("both sides: the past negative, each tick at the mirror place of its distance", () => {
    const a = logAxis(10 * MIN, 120, 1440);
    const ticks = logTicks(a, -a.uLo - 720, 1440, NOW);
    const x0 = logX(a, NOW, NOW);
    const pos = ticks.filter((k) => k.t > NOW);
    const neg = ticks.filter((k) => k.t < NOW);
    expect(pos.length).toBeGreaterThan(3);
    expect(neg.length).toBeGreaterThan(3);
    for (const k of neg) {
      expect(k.label.startsWith("-")).toBe(true);
      expect(x0 - k.x).toBeCloseTo(logX(a, NOW + (NOW - k.t), NOW) - x0, 6);
    }
    for (const k of pos) expect(k.label.startsWith("-")).toBe(false);
  });
  it("only around the view (a screen either side): bounded, far views have no Now", () => {
    const a = logAxis(MIN, 200, 1440);
    const far = logTicks(a, 0, 1440, NOW);
    expect(far.every((k) => k.x <= 2 * 1440)).toBe(true);
    expect(far.some((k) => k.now)).toBe(false);
    expect(logTicks(a, 0, 0, NOW).length).toBeLessThan(10);
  });
  it("re-ticks as it zooms", () => {
    const a = logAxis(HOUR, 60, 390);
    const z = zoomLogAxis(a, -a.uLo - 130, 390, 130, 9, NOW);
    const l0 = logTicks(a, -a.uLo - 130, 390, NOW).map((k) => k.label);
    const l1 = logTicks(z.axis, z.scrollLeft, 390, NOW).map((k) => k.label);
    expect(l1).not.toEqual(l0);
  });
  it("the linear axis's labels never overlap either, at a larger text too", () => {
    for (const charPx of [CHAR_PX, 12])
      for (const p of [
        W / MIN_SCREEN_MS,
        W / HOUR,
        W / (3 * DAY),
        W / MAX_SCREEN_MS,
        360 / MAX_SCREEN_MS,
      ]) {
        const a: Axis = { lo: NOW - 30 * DAY, hi: NOW + 30 * DAY, pxPerMs: p };
        const ticks = axisTicks(a, xOf(a, NOW) - 300, W, NOW, charPx);
        noOverlap(ticks, charPx);
        expect(tickStep(p, tickMinPx(charPx)) * p).toBeGreaterThanOrEqual(tickMinPx(charPx));
      }
    expect(tickMinPx()).toBe(TICK_MIN_PX);
    expect(tickMinPx(12)).toBeGreaterThan(TICK_MIN_PX);
  });
});

describe("one interface over both axes", () => {
  const lin: Axis = { lo: NOW - 2 * HOUR, hi: NOW + 2 * HOUR, pxPerMs: W / HOUR };
  const log = logAxis(10 * MIN, 120, W);
  it("x, width, ticks, zoom, extend and Now dispatch on the kind", () => {
    expect(scaleX(lin, NOW, NOW)).toBe(xOf(lin, NOW));
    expect(scaleX(log, NOW, NOW)).toBe(logX(log, NOW, NOW));
    expect(scaleWidth(lin)).toBe(axisWidth(lin));
    expect(scaleTicks(lin, 0, W, NOW)).toEqual(axisTicks(lin, 0, W, NOW));
    expect(scaleTicks(log, 0, W, NOW)).toEqual(logTicks(log, 0, W, NOW));
    expect(scaleZoom(lin, 100, W, 10, 2, NOW)).toEqual(zoomAxis(lin, 100, W, 10, 2));
    expect(scaleZoom(log, 100, W, 10, 2, NOW)).toEqual(zoomLogAxis(log, 100, W, 10, 2, NOW));
    expect(scaleExtend(lin, 0, W)).toEqual(extendAxis(lin, 0, W));
    expect(scaleExtend(log, 0, W)).toEqual({ axis: log, scrollLeft: 0 });
    expect(scaleToNow(lin, W, NOW)).toEqual(axisToNow(lin, W, NOW));
    const n = scaleToNow(log, W, NOW);
    expect(n.axis).toBe(log);
    expect(logX(log, NOW, NOW) - n.scrollLeft).toBeCloseTo(LOG_NOW_AT * W);
    expect(logAxisToNow(log, 0).scrollLeft).toBeCloseTo(-log.uLo - LOG_NOW_AT);
  });
  it("bars on the log axis: each end projected; overdue runs on to Now", () => {
    const b = ganttBar({ start: NOW - 30 * MIN, at: NOW + 3 * HOUR, pct: 50 }, log, NOW);
    expect(b.x).toBeCloseTo(logX(log, NOW - 30 * MIN, NOW));
    expect(b.x + b.w).toBeCloseTo(logX(log, NOW + 3 * HOUR, NOW));
    expect(b.fill).toBeCloseTo(b.w / 2);
    const late = ganttBar({ start: NOW - 2 * HOUR, at: NOW - HOUR }, log, NOW);
    expect(late.x + late.w + late.over).toBeCloseTo(logX(log, NOW, NOW));
    // A minute task near Now is wider than a minute task a day away.
    const near = ganttBar({ start: NOW, at: NOW + MIN }, log, NOW).w;
    const away = ganttBar({ start: NOW + DAY, at: NOW + DAY + MIN }, log, NOW).w;
    expect(near).toBeGreaterThan(10 * away);
  });
});
