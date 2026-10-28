import { describe, expect, test } from "bun:test";
import {
  lockAxis,
  projectSwipe,
  releaseRating,
  releaseVelocity,
  swipeRating,
} from "@/lib/words/swipe";

describe("swipe physics", () => {
  test("distance picks the grade: short is milder, long is stronger", () => {
    expect(swipeRating(0)).toBeNull();
    expect(swipeRating(50)).toBe(3);
    expect(swipeRating(120)).toBe(4);
    expect(swipeRating(-50)).toBe(2);
    expect(swipeRating(-120)).toBe(1);
  });

  test("a flick coasts further than a slow drag", () => {
    // A slow, deliberate 50px drag stays Good.
    expect(swipeRating(projectSwipe(50, 0.2))).toBe(3);
    // The same 50px released at a flick's speed lands on Easy.
    expect(swipeRating(projectSwipe(50, 1.5))).toBe(4);
    // A tiny flick still grades; a left flick reaches Again.
    expect(swipeRating(projectSwipe(15, 0.6))).toBe(3);
    expect(swipeRating(projectSwipe(-45, -1.2))).toBe(1);
    // Projection is bounded.
    expect(projectSwipe(100, 50)).toBe(400);
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
    expect(releaseRating(20, 1.5)).toBe(4);
    expect(releaseRating(-50, 0)).toBe(2);
  });
});
