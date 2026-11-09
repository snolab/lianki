import { describe, expect, it } from "bun:test";
import {
  type Axis,
  EXTEND_SCREENS,
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
