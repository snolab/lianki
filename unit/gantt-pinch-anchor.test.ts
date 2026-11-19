import { describe, expect, it } from "bun:test";
import {
  GANTT_MAX_ROW_H,
  GANTT_MIN_ROW_H,
  GANTT_ROW_H,
  initialScale,
  pinchDirection,
  pinchFactors,
  pinchOf,
  pinchRowHeight,
  pinchScrollTop,
  pinchStart,
  pinchView,
  scaleX,
} from "@lianki/debug-chat/gantt-view";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = 1_800_000_000_000;
const W = 390;

describe("pinch: the time under the fingers stays under them (owner, 2026-11-10)", () => {
  for (const kind of ["linear", "log"] as const)
    it(`${kind}: t0 under the midpoint's px (±0.5) at any factor, the midpoint moving too`, () => {
      const open = initialScale(kind, NOW - 2 * HOUR, NOW + 3 * HOUR, NOW, W);
      for (const anchor0 of [40, 195, 350]) {
        const start = pinchStart(open.axis, open.scrollLeft, anchor0, NOW);
        for (const factor of [0.2, 0.5, 0.9, 1, 1.07, 1.5, 3, 12, 1e4, 1e-4])
          for (const anchor of [anchor0, anchor0 - 30, anchor0 + 25]) {
            const v = pinchView(start, factor, anchor, W, NOW);
            const px = scaleX(v.axis, start.t0, NOW) - v.scrollLeft;
            expect(Math.abs(px - anchor)).toBeLessThanOrEqual(0.5);
          }
      }
    });

  it("a factor of 1 with the fingers still changes nothing", () => {
    for (const kind of ["linear", "log"] as const) {
      const open = initialScale(kind, NOW - HOUR, NOW + HOUR, NOW, W);
      const start = pinchStart(open.axis, open.scrollLeft, 200, NOW);
      const v = pinchView(start, 1, 200, W, NOW);
      expect(scaleX(v.axis, start.t0, NOW) - v.scrollLeft).toBeCloseTo(200, 6);
    }
  });

  it("each move is from the start, not the last frame: no drift after many steps", () => {
    for (const kind of ["linear", "log"] as const) {
      const open = initialScale(kind, NOW - HOUR, NOW + HOUR, NOW, W);
      const start = pinchStart(open.axis, open.scrollLeft, 120, NOW);
      let v = pinchView(start, 1, 120, W, NOW);
      for (let i = 1; i <= 200; i++) v = pinchView(start, 1 + i * 0.013, 120 + (i % 7), W, NOW);
      expect(
        Math.abs(scaleX(v.axis, start.t0, NOW) - v.scrollLeft - (120 + (200 % 7))),
      ).toBeLessThanOrEqual(0.5);
    }
  });

  it("distinguishes horizontal (time) vs vertical (row height) vs diagonal pinch directions", () => {
    const p0 = pinchOf([
      { clientX: 100, clientY: 200 },
      { clientX: 160, clientY: 260 },
    ]);
    expect(p0).toEqual({ dist: Math.hypot(60, 60), dx: 60, dy: 60, cx: 130, cy: 230 });

    // Below lock threshold (< 6px): no zoom on either axis
    const near = { dx: 63, dy: 62 };
    expect(pinchDirection(p0, near)).toBe("none");
    expect(pinchFactors(p0, near)).toEqual({ dir: "none", fx: 1, fy: 1 });

    // Horizontal pinch: only fx scales, fy stays 1
    const horiz = { dx: 120, dy: 65 };
    expect(pinchDirection(p0, horiz)).toBe("x");
    expect(pinchFactors(p0, horiz)).toEqual({ dir: "x", fx: 2, fy: 1 });

    // Vertical pinch: only fy scales, fx stays 1
    const vert = { dx: 65, dy: 120 };
    expect(pinchDirection(p0, vert)).toBe("y");
    expect(pinchFactors(p0, vert)).toEqual({ dir: "y", fx: 1, fy: 2 });

    // Diagonal pinch: both fx and fy scale independently; explicit lock overrides
    const diag = { dx: 90, dy: 90 };
    expect(pinchDirection(p0, diag)).toBe("both");
    expect(pinchFactors(p0, diag)).toEqual({ dir: "both", fx: 1.5, fy: 1.5 });
    expect(pinchFactors(p0, diag, "x")).toEqual({ dir: "x", fx: 1.5, fy: 1 });
  });

  it("clamps pinched row height and keeps the vertical row anchor under the midpoint", () => {
    expect(pinchRowHeight(GANTT_ROW_H, 1)).toBe(30);
    expect(pinchRowHeight(GANTT_ROW_H, 1.5)).toBe(45);
    expect(pinchRowHeight(GANTT_ROW_H, 10)).toBe(GANTT_MAX_ROW_H);
    expect(pinchRowHeight(GANTT_ROW_H, 0.1)).toBe(GANTT_MIN_ROW_H);
    expect(pinchRowHeight(GANTT_ROW_H, Number.NaN)).toBe(30);
    expect(pinchRowHeight(GANTT_ROW_H, -1)).toBe(30);

    // Pure pan (total1 === total0): simplifies to top0 + (anchorY0 - anchorY)
    expect(
      pinchScrollTop({
        top0: 100,
        anchorY0: 200,
        anchorY: 180,
        originY: 50,
        total0: 600,
        total1: 600,
      }),
    ).toBe(120);

    // 2x vertical row height zoom: point at offset0 = (100 + 200 - 50) = 250 moves to 50 + 500 = 550;
    // to keep it at anchorY = 210, scrollTop = 550 - 210 = 340
    expect(
      pinchScrollTop({
        top0: 100,
        anchorY0: 200,
        anchorY: 210,
        originY: 50,
        total0: 600,
        total1: 1200,
      }),
    ).toBe(340);
  });
});
