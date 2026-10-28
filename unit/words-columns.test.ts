import { describe, expect, test } from "bun:test";
import { centreWeight, ease, nextGoal, termTarget, weightedQuantile } from "@/lib/words/columns";

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

  test("easing glides toward the goal and lands on it", () => {
    const step = ease(100, 200, 16);
    expect(step).toBeGreaterThan(100);
    expect(step).toBeLessThan(200);
    expect(ease(199.8, 200, 16)).toBe(200);
  });
});
