import { describe, expect, test } from "bun:test";
import { createEmptyCard, type Card } from "ts-fsrs";
import { daysToPass, projectCurve } from "@/lib/words/gate-eta";
import { DEFAULT_WORD_PARAMS, reviewWord } from "@/lib/words/schedule";

const now = new Date("2026-10-31T00:00:00Z");
const params = DEFAULT_WORD_PARAMS;
const seenCard = () => reviewWord(createEmptyCard<Card>(now), 3, now, params, false).card;

describe("when the next level opens", () => {
  test("progress only grows when every review is Good, and seen grows at the pace", () => {
    const c = projectCurve({
      size: 100,
      cards: [seenCard(), seenCard()],
      params,
      pace: 5,
      now,
      horizon: 400,
    });
    for (let d = 1; d < c.score.length; d++)
      expect(c.score[d]).toBeGreaterThanOrEqual(c.score[d - 1] - 1e-9);
    expect(c.seen[0]).toBe(7);
    expect(c.seen[400]).toBe(100);
  });

  test("already at the pass mark: opens now; never reaching it: null", () => {
    expect(daysToPass({ seen: [10], score: [6] }, 10, 0.6)).toBe(0);
    expect(daysToPass({ seen: [10, 10], score: [1, 2] }, 10, 0.6)).toBeNull();
  });

  test("a faster pace passes sooner, and 60% takes months, not days", () => {
    const run = (pace: number) =>
      daysToPass(projectCurve({ size: 200, cards: [], params, pace, now, horizon: 730 }), 200, 0.6);
    const slow = run(2)!;
    const fast = run(20)!;
    expect(fast).toBeLessThan(slow);
    expect(fast).toBeGreaterThan(30);
  });
});
