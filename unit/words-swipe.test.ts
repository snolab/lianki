import { describe, expect, test } from "bun:test";
import {
  clampSwipe,
  lockAxis,
  projectSwipe,
  releaseRating,
  releaseVelocity,
  swipeRating,
  swipeTier,
} from "@/lib/words/swipe";

describe("swipe physics", () => {
  test("tiers by resting position: mild up to 1.5a, strong beyond; 2a is the stop", () => {
    const a = 44;
    expect(swipeRating(0, a)).toBeNull();
    expect(swipeRating(10, a)).toBeNull();
    expect(swipeRating(30, a)).toBe(3);
    expect(swipeRating(66, a)).toBe(3);
    expect(swipeRating(67, a)).toBe(4);
    expect(swipeRating(-30, a)).toBe(2);
    expect(swipeRating(-80, a)).toBe(1);
    expect(swipeTier(5)).toBe(0);
    expect(swipeTier(-60)).toBe(1);
    expect(swipeTier(-70)).toBe(2);
  });

  test("beyond a the row resists; it stops at 2a", () => {
    const a = 44;
    expect(clampSwipe(30, a)).toBe(30);
    expect(clampSwipe(64, a)).toBe(52); // 20px past a moves 8
    expect(clampSwipe(-500, a)).toBe(-88);
    // An 80px drag stays mild; reaching strong takes ~2.25a (99px) of finger.
    expect(swipeRating(clampSwipe(80, a), a)).toBe(3);
    expect(swipeRating(clampSwipe(100, a), a)).toBe(4);
  });

  test("a flick coasts further than a slow drag, but never past the stop", () => {
    expect(swipeRating(projectSwipe(30, 0.05))).toBe(3);
    expect(swipeRating(projectSwipe(30, 0.5))).toBe(3);
    expect(swipeRating(projectSwipe(30, 1))).toBe(3);
    expect(swipeRating(projectSwipe(30, 2.5))).toBe(4);
    expect(swipeRating(projectSwipe(-30, -1.2))).toBe(2);
    expect(swipeRating(projectSwipe(-30, -2.5))).toBe(1);
    expect(projectSwipe(30, 50)).toBe(88);
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
    expect(releaseRating(20, 1.5)).toBe(3);
    expect(releaseRating(20, 3)).toBe(4);
    expect(releaseRating(20, 0)).toBe(3);
    expect(releaseRating(20, 0.5)).toBe(3);
    expect(releaseRating(-50, 0)).toBe(2);
    expect(releaseRating(-70, 0)).toBe(2);
    expect(releaseRating(-110, 0)).toBe(1);
  });
});
