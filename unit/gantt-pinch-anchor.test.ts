import { describe, expect, it } from "bun:test";
import { initialScale, pinchStart, pinchView, scaleX } from "@lianki/debug-chat/gantt-view";

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
});
