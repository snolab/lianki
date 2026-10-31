import { describe, expect, test } from "bun:test";
import {
  centreWeight,
  frameDt,
  glideStep,
  nextGoal,
  termTarget,
  weightedQuantile,
  SPLIT_MIN_REM,
  splitTarget,
} from "@/lib/words/columns";

const REM = 16;

describe("term column width", () => {
  test("weighted quantile ignores weightless rows and empty input", () => {
    expect(weightedQuantile([], 0.85)).toBe(0);
    expect(
      weightedQuantile(
        [
          [10, 1],
          [20, 1],
          [999, 0],
        ],
        0.85,
      ),
    ).toBe(20);
    expect(weightedQuantile([[5, 1]], 1.5)).toBe(5);
  });

  test("rows at the centre count; rows at the edges barely do", () => {
    expect(centreWeight(0, 800)).toBe(1);
    expect(centreWeight(800, 800)).toBeLessThan(0.02);
  });

  test("short terms leave room; one long outlier does not widen; clamped", () => {
    const short = Array.from({ length: 20 }, (_, i) => ({ width: 40, distance: i * 28 }));
    expect(termTarget(short, 800, REM)).toBe(6 * REM);
    const withOutlier = [...short, { width: 600, distance: 0 }];
    expect(termTarget(withOutlier, 800, REM)).toBe(6 * REM);
    const long = short.map((r) => ({ ...r, width: 200 }));
    expect(termTarget(long, 800, REM)).toBe(200 + REM);
    expect(
      termTarget(
        long.map((r) => ({ ...r, width: 900 })),
        800,
        REM,
      ),
    ).toBe(20 * REM);
    expect(
      termTarget(
        long.map((r) => ({ ...r, width: 900 })),
        800,
        REM,
        true,
      ),
    ).toBe(12 * REM);
  });

  test("the goal holds inside the dead band and moves in quantized steps", () => {
    expect(nextGoal(null, 101, REM)).toBe(104);
    expect(nextGoal(104, 120, REM)).toBe(104);
    expect(nextGoal(104, 140, REM)).toBe(144);
  });
});

describe("splitTarget", () => {
  const rem = 16;
  const min = SPLIT_MIN_REM * rem;
  test("both fit: each gets its need, the rest is split evenly", () => {
    expect(splitTarget(200, 100, 600, rem)).toBe(200 + 150);
  });
  test("they do not fit: shared in proportion to need", () => {
    expect(splitTarget(900, 300, 600, rem)).toBe(450);
  });
  test("neither column goes below the minimum", () => {
    expect(splitTarget(2000, 10, 600, rem)).toBe(600 - min);
    expect(splitTarget(10, 2000, 600, rem)).toBe(min);
  });
  test("too little room, or nothing measured: halves", () => {
    expect(splitTarget(500, 500, 2 * min - 10, rem)).toBe(min - 5);
    expect(splitTarget(0, 0, 600, rem)).toBe(300);
  });
});

describe("column glide", () => {
  test("frameDt: first frame is one 60 Hz frame; never negative; a stall is capped", () => {
    expect(frameDt(1000, null)).toBeCloseTo(1 / 60);
    expect(frameDt(1000, 1008.3)).toBe(0);
    expect(frameDt(1016.7, 1000)).toBeCloseTo(0.0167, 4);
    expect(frameDt(5000, 1000)).toBeCloseTo(1 / 30);
  });

  test("moves at sub-pixel precision, monotonically, without overshoot", () => {
    let x = 100;
    let v = 0;
    const xs: number[] = [];
    for (let i = 0; i < 120; i++) {
      const s = glideStep(x, v, 124, 1 / 120);
      x = s.x;
      v = s.v;
      xs.push(x);
      if (s.settled) break;
    }
    expect(xs.some((p) => p !== Math.round(p))).toBe(true);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1]);
    expect(Math.max(...xs)).toBeLessThanOrEqual(124);
    // At 120 Hz no frame moves more than a few px.
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeLessThan(3);
  });

  test("settles exactly on the goal, within about half a second", () => {
    let s = { x: 100, v: 0, settled: false };
    let t = 0;
    while (!s.settled && t < 2) {
      s = glideStep(s.x, s.v, 124, 1 / 60);
      t += 1 / 60;
    }
    expect(s).toEqual({ x: 124, v: 0, settled: true });
    expect(t).toBeLessThan(0.6);
  });

  test("dt 0 holds still; reduced motion jumps straight to the goal", () => {
    expect(glideStep(100, 0, 124, 0).x).toBe(100);
    expect(glideStep(100, 0, 124, -0.01).x).toBe(100);
    expect(glideStep(100, 50, 124, 1 / 60, true)).toEqual({ x: 124, v: 0, settled: true });
  });
});
