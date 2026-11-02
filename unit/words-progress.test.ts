import { describe, expect, test } from "bun:test";
import { PROGRESS_SCALE_DAYS, progressPercent, scoreSum, wordScore } from "@/lib/words/progress";
import { createTestD1 } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { WordsD1Repo } from "@/lib/repos/wordsD1";

describe("word score: min(1, ln(1+s) / ln(1+scale))", () => {
  test("a year or more counts in full", () => {
    expect(PROGRESS_SCALE_DAYS).toBe(365);
    expect(wordScore({ stability: 365 })).toBeCloseTo(1, 12);
    expect(wordScore({ stability: 4000 })).toBe(1);
  });
  test("partial stability counts on a log scale", () => {
    expect(wordScore({ stability: 1 })).toBeCloseTo(Math.log(2) / Math.log(366), 12);
    // A month is already over half way: log scale.
    expect(wordScore({ stability: 30 })).toBeCloseTo(Math.log(31) / Math.log(366), 12);
    expect(wordScore({ stability: 30 })).toBeGreaterThan(0.5);
  });
  test("the interval stands in for a missing stability", () => {
    expect(wordScore({ stability: null, interval: 30 })).toBe(wordScore({ stability: 30 }));
    expect(wordScore({ interval: 30 })).toBe(wordScore({ stability: 30 }));
    expect(wordScore({ stability: 0, interval: 30 })).toBe(wordScore({ stability: 30 }));
  });
  test("nothing known scores 0", () => {
    expect(wordScore({})).toBe(0);
    expect(wordScore({ stability: -1, interval: null })).toBe(0);
    expect(wordScore({ stability: 10 }, 0)).toBe(0);
  });
  test("the scale is a parameter (a list's shorter cap)", () => {
    expect(wordScore({ stability: 100 }, 100)).toBeCloseTo(1, 12);
    expect(wordScore({ stability: 10 }, 100)).toBeCloseTo(Math.log(11) / Math.log(101), 12);
  });
});

describe("list progress: the mean over every word, unstudied as 0", () => {
  test("sums and divides by the list's size", () => {
    const sum = scoreSum([{ stability: 365 }, { stability: 365 }]);
    expect(sum).toBeCloseTo(2, 12);
    expect(progressPercent(sum, 4)).toBe(50); // two unstudied words count 0
    expect(progressPercent(sum, 2)).toBe(100);
  });
  test("rounds down, so 100% only when every word is in full", () => {
    expect(progressPercent(0.999 * 10, 10)).toBe(99);
    expect(progressPercent(0.29 * 100, 100)).toBe(29);
  });
  test("unknown size: no percentage; clamps out-of-range sums", () => {
    expect(progressPercent(3, 0)).toBeNull();
    expect(progressPercent(5, 2)).toBe(100);
    expect(progressPercent(-1, 2)).toBe(0);
  });
  test("a group sums its subtree before dividing (Anki subdeck rule)", () => {
    const a = { sum: scoreSum([{ stability: 365 }]), total: 1 };
    const b = { sum: 0, total: 3 };
    expect(progressPercent(a.sum + b.sum, a.total + b.total)).toBe(25);
  });
});

test("the repo sends each list's score sum, against its interval cap", async () => {
  const d1 = createTestD1(testSchema());
  const repo = new WordsD1Repo(d1, "p@example.com");
  const id = await repo.createList({ name: "x", lang: "fr" });
  await repo.review(
    id,
    [
      { term: "a", rating: 3 },
      { term: "b", rating: 3 },
    ],
    "2026-10-27",
  );
  await d1
    .prepare("UPDATE word_cards SET card = json_set(card, '$.stability', 365) WHERE term = 'a'")
    .run();
  await d1
    .prepare(
      "UPDATE word_cards SET card = json_set(card, '$.stability', 0, '$.scheduled_days', 30) WHERE term = 'b'",
    )
    .run();
  const list = (await repo.getList(id))!;
  expect(list.progress).toBeCloseTo(1 + Math.log(31) / Math.log(366), 9);
  const [all] = await repo.lists();
  expect(all.progress).toBeCloseTo(list.progress, 12);
});
