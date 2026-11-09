import { describe, expect, it } from "bun:test";
import {
  GANTT_END_SPACE,
  GANTT_FIT_NEIGHBOURS,
  GANTT_FIT_PERCENTILE,
  LOG_MAX_T,
  LOG_MIN_T,
  centreRowTop,
  fitSpan,
  focusRow,
  ganttRowsByEnd,
  homeView,
  isLog,
  pinchOf,
  quantile,
  rowEnd,
  scaleX,
  symlog,
  zoomLimits,
} from "@lianki/debug-chat/gantt-view";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = 1_800_000_000_000;
const W = 390;

/** A task from `s` to `e` minutes from now (done at `d` if given). */
const task = (id: string, s: number, e: number, d?: number) => ({
  id,
  start: NOW + s * MIN,
  at: NOW + e * MIN,
  ...(d === undefined ? {} : { done: true, doneAt: NOW + d * MIN }),
});

describe("rows by end time, expected or actual (owner, 2026-11-10)", () => {
  it("sorts by the actual end for done rows and the expected end for open ones", () => {
    const rows = ganttRowsByEnd([
      task("late-open", -10, 50),
      task("done-early", -120, -30, -60),
      task("soon", -5, 10),
      task("done-late", -50, -40, 5),
    ]);
    expect(rows.map((t) => t.id)).toEqual(["done-early", "done-late", "soon", "late-open"]);
    expect(rowEnd(rows[1]!)).toBe(NOW + 5 * MIN);
  });
});

describe("focusRow: the open task closest to ending", () => {
  it("the soonest expected end still in the future", () => {
    const rows = ganttRowsByEnd([task("a", -30, -5), task("b", -10, 20), task("c", -5, 40)]);
    expect(rows[focusRow(rows, NOW)]!.id).toBe("b");
  });
  it("no open task in the future: the row whose end is nearest now", () => {
    const rows = ganttRowsByEnd([task("x", -90, -60, -60), task("y", -30, -8, -8)]);
    expect(rows[focusRow(rows, NOW)]!.id).toBe("y");
    expect(focusRow([], NOW)).toBe(-1);
  });
});

describe("the fitted zoom: the 95th-percentile duration fills the width", () => {
  it("the percentile is the one named number", () => {
    expect(GANTT_FIT_PERCENTILE).toBe(0.95);
    expect(
      quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], 0.95),
    ).toBe(19);
    expect(quantile([], 0.95)).toBe(0);
  });

  it("uses the focus row and its neighbours only", () => {
    // Ten rows of 10 min each, and one far one of 10 h outside the window.
    const rows = ganttRowsByEnd([
      task("far", -600, -590, -0.5 * 60 * 24),
      ...Array.from({ length: 10 }, (_, i) => task(`r${i}`, i * 10 - 5, i * 10 + 5)),
    ]);
    const f = focusRow(rows, NOW);
    expect(rows[f]!.id).toBe("r0");
    expect(GANTT_FIT_NEIGHBOURS).toBeGreaterThan(0);
    expect(fitSpan(rows, f)).toBe(10 * MIN);
  });

  it("linear: centre x is now, and the span is exactly the visible width", () => {
    const span = 40 * MIN;
    const v = homeView("linear", span, NOW, W, { from: NOW, to: NOW });
    expect(isLog(v.axis)).toBe(false);
    expect(scaleX(v.axis, NOW, NOW) - v.scrollLeft).toBeCloseTo(W / 2, 5);
    const left = scaleX(v.axis, NOW - span / 2, NOW) - v.scrollLeft;
    const right = scaleX(v.axis, NOW + span / 2, NOW) - v.scrollLeft;
    // Fills the width, never past it.
    expect(left).toBeCloseTo(0, 5);
    expect(right).toBeCloseTo(W, 5);
  });

  it("log: centre x is now, and a span centred on now runs edge to edge", () => {
    const span = 3 * HOUR;
    const v = homeView("log", span, NOW, W, { from: NOW, to: NOW });
    expect(isLog(v.axis)).toBe(true);
    expect(scaleX(v.axis, NOW, NOW) - v.scrollLeft).toBeCloseTo(W / 2, 5);
    if (!isLog(v.axis)) throw new Error("log");
    expect(v.axis.T).toBeGreaterThanOrEqual(LOG_MIN_T);
    expect(v.axis.T).toBeLessThanOrEqual(LOG_MAX_T);
    expect(2 * symlog(span / 2, v.axis.T, v.axis.L)).toBeCloseTo(W, 3);
  });

  it("the most bars of the window fit, the longest at most the width", () => {
    const rows = ganttRowsByEnd([
      task("a", -20, 10),
      task("b", -10, 25),
      task("c", 0, 60),
      task("d", -45, -15, -15),
    ]);
    const span = fitSpan(rows, focusRow(rows, NOW));
    const v = homeView("linear", span, NOW, W, { from: NOW, to: NOW });
    for (const t of rows) {
      const px = scaleX(v.axis, rowEnd(t), NOW) - scaleX(v.axis, Math.min(t.start, t.at), NOW);
      expect(px).toBeLessThanOrEqual(W + 1e-6);
      expect(px).toBeGreaterThan(0);
    }
  });

  it("within the zoom limits", () => {
    const v = homeView("linear", 1, NOW, W, { from: NOW, to: NOW });
    if (isLog(v.axis)) throw new Error("linear");
    expect(v.axis.pxPerMs).toBe(zoomLimits(W).max);
  });

  it("no span: the axis's own open zoom, Now still centred", () => {
    const v = homeView("linear", 0, NOW, W, { from: NOW - HOUR, to: NOW + HOUR });
    expect(scaleX(v.axis, NOW, NOW) - v.scrollLeft).toBeCloseTo(W / 2, 5);
  });
});

describe("vertical: the focus row in the middle, blank space at both ends", () => {
  it("centres the row under the sticky axis", () => {
    const viewH = 700;
    const head = GANTT_END_SPACE * viewH;
    const top = centreRowTop({ i: 4, viewH, axisH: 26, headSpace: head, rowH: 30, rowGap: 2 });
    const rowMid = 26 + head + 4 * 32 + 15;
    expect(rowMid - top).toBeCloseTo(26 + (viewH - 26) / 2, 0);
    expect(centreRowTop({ i: -1, viewH, axisH: 26, headSpace: head, rowH: 30, rowGap: 2 })).toBe(0);
  });
  it("the space is one named share of the view", () => {
    expect(GANTT_END_SPACE).toBeGreaterThan(0);
    expect(GANTT_END_SPACE).toBeLessThanOrEqual(1);
  });
});

describe("pinch: the midpoint both ways", () => {
  it("cx and cy", () => {
    const p = pinchOf([
      { clientX: 100, clientY: 200 },
      { clientX: 300, clientY: 400 },
    ]);
    expect(p).toMatchObject({ cx: 200, cy: 300 });
  });
});
