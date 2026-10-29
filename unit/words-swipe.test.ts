import { describe, expect, test } from "bun:test";
import {
  levelRating,
  lockAxis,
  releaseLevel,
  releaseRating,
  releaseVelocity,
  snapSwipe,
  springProgress,
  swipeLevel,
} from "@/lib/words/swipe";

describe("swipe detents", () => {
  const a = 44;
  test("the row snaps: a quarter of the finger on a level, 1.75× between", () => {
    expect(snapSwipe(0, a)).toBe(0);
    expect(snapSwipe(44, a)).toBeCloseTo(44, 6);
    expect(snapSwipe(-88, a)).toBeCloseTo(-88, 6);
    // On a level the row gives a little; between levels it slides on.
    const slope = (f: number) => (snapSwipe(f + 0.01, a) - snapSwipe(f, a)) / 0.01;
    expect(slope(44)).toBeCloseTo(0.25, 2);
    expect(slope(22)).toBeCloseTo(1.75, 2);
    // Smooth through every level: no jumps.
    for (let f = -120; f < 120; f += 0.5)
      expect(Math.abs(snapSwipe(f + 0.5, a) - snapSwipe(f, a))).toBeLessThan(1);
  });

  test("past the last level it stretches, then stops", () => {
    expect(snapSwipe(98, a)).toBeCloseTo(88 + 10 * 0.3, 6);
    expect(snapSwipe(-500, a)).toBe(-110);
  });

  test("levels have hysteresis: 0→1 at 0.6L, 1→2 at 1.6L, and back the same", () => {
    expect(swipeLevel(26, 0, a)).toBe(0);
    expect(swipeLevel(27, 0, a)).toBe(1);
    expect(swipeLevel(70, 1, a)).toBe(1);
    expect(swipeLevel(71, 1, a)).toBe(2);
    expect(swipeLevel(66, 2, a)).toBe(2); // resting on the line keeps the level
    expect(swipeLevel(61, 2, a)).toBe(1);
    expect(swipeLevel(-71, 0, a)).toBe(-2);
    expect(swipeLevel(500, 0, a)).toBe(2);
    expect([-2, -1, 0, 1, 2].map(levelRating)).toEqual([1, 2, null, 3, 4]);
  });

  test("a flick moves at most one level past where it was held", () => {
    expect(releaseLevel(30, 0, 1, a)).toBe(1);
    expect(releaseLevel(30, 3, 1, a)).toBe(2);
    expect(releaseLevel(5, 10, 0, a)).toBe(1);
    expect(releaseLevel(-30, -3, -1, a)).toBe(-2);
  });

  test("the return spring settles at 1 and never overshoots", () => {
    expect(springProgress(0)).toBe(0);
    expect(springProgress(1)).toBe(1);
    let last = 0;
    for (let t = 0; t <= 1; t += 0.05) {
      expect(springProgress(t)).toBeGreaterThanOrEqual(last);
      last = springProgress(t);
    }
    expect(springProgress(0.95)).toBeGreaterThan(0.99);
  });
  test("release velocity: recent samples only, zero after a pause", () => {
    const s = [
      { t: 0, x: 0 },
      { t: 200, x: 10 },
      { t: 250, x: 40 },
      { t: 300, x: 100 },
    ];
    expect(releaseVelocity(s, 300)).toBeCloseTo((100 - 10) / 100);
    // Finger stopped 80ms before lifting: no coasting.
    expect(releaseVelocity(s, 380)).toBe(0);
    expect(releaseVelocity([{ t: 0, x: 0 }], 10)).toBe(0);
    expect(
      releaseVelocity(
        [
          { t: 5, x: 0 },
          { t: 5, x: 9 },
        ],
        5,
      ),
    ).toBe(0);
  });
});

describe("swipe vs scroll", () => {
  test("the axis locks after the slop, steep gestures are scrolls", () => {
    expect(lockAxis(3, 4)).toBeNull();
    expect(lockAxis(20, 5)).toBe("h");
    expect(lockAxis(-20, 10)).toBe("h");
    expect(lockAxis(12, 12)).toBe("v");
    expect(lockAxis(2, -30)).toBe("v");
  });

  test("a twitch never grades, however fast", () => {
    expect(releaseRating(10, 3)).toBeNull();
    // Held on no level: a slow lift grades nothing, a flick only the mild grade.
    expect(releaseRating(20, 0)).toBeNull();
    expect(releaseRating(20, 3)).toBe(3);
    expect(releaseRating(30, 0)).toBe(3);
    expect(releaseRating(30, 3, 1)).toBe(4);
    expect(releaseRating(-50, 0)).toBe(2);
    expect(releaseRating(-80, 0)).toBe(1);
  });
});
