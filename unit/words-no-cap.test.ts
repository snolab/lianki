/**
 * No daily new-word cap (owner, 2026-10-31): /words is an endless scroll, not a
 * daily quota. The old per-list `newPerDay` (default 50) must not limit
 * anything, on the server or in the client's new-word path, and the toolbar's
 * "{new} unseen" counts every never-shown word in scope.
 */
import { describe, expect, test } from "bun:test";
import { testSchema } from "@/lib/d1/testSchema";
import { createTestD1 } from "@/lib/d1/testDb";
import { WordsD1Repo } from "@/lib/repos/wordsD1";
import { newScan, takeNewIndices, type CheckKnown } from "@/lib/words/take-new";
import { countGradedNew, unseenLeft } from "@/lib/words/unseen";

const DAY = "2026-10-31";

describe("no daily new-word cap", () => {
  for (const n of [50, 200, 1000]) {
    test(`${n} new words in one day all get cards, and the next one is still taken`, async () => {
      const d1 = createTestD1(testSchema());
      const repo = new WordsD1Repo(d1, `cap${n}@example.com`);
      const id = await repo.createList({ name: "N5", lang: "ja", source: "ja-jlpt-n5" });
      // A list saved before the cap was removed still carries newPerDay: 50.
      await d1
        .prepare("UPDATE word_lists SET params = ? WHERE id = ?")
        .bind(JSON.stringify({ newPerDay: 50 }), id)
        .run();
      const t0 = new Date("2026-10-31T01:00:00Z");
      // The review route takes at most 200 per call.
      for (let from = 0; from < n; from += 200) {
        const batch = Array.from({ length: Math.min(200, n - from) }, (_, k) => {
          const i = from + k;
          return { term: `w${i}`, rating: 3 as const, newIndex: i };
        });
        const res = await repo.review(id, batch, DAY, t0, from + batch.length);
        expect(res!.cards).toHaveLength(batch.length);
        expect(res).not.toHaveProperty("newRemaining");
      }
      const one = await repo.review(
        id,
        [{ term: "extra", rating: 3, newIndex: n }],
        DAY,
        t0,
        n + 1,
      );
      expect(one!.cards).toHaveLength(1);
      expect(await repo.getList(id, t0)).toMatchObject({ cards: n + 1, newToday: n + 1 });
      expect((await repo.getList(id, t0))!.params).not.toHaveProperty("newPerDay");
      const s = await repo.sessionMany([id], DAY, t0);
      expect(s.lists[id]).toEqual({ due: [] });
    });

    test(`the client's new-word path takes ${n} words and more from one list`, async () => {
      const terms = Array.from({ length: n + 500 }, (_, i) => `w${i}`);
      const check: CheckKnown = async () => new Set();
      const scan = newScan(0);
      const first = await takeNewIndices(terms, scan, n, check);
      expect(first).toHaveLength(n);
      expect(await takeNewIndices(terms, scan, 40, check)).toHaveLength(40);
    });
  }
});

describe("the toolbar's unseen count", () => {
  test("is each list's size minus its cards, summed over the scope", () => {
    // "Study all lists together": N5 710 (200 seen), N4 668 (0 seen), a group row (0).
    const scope = [
      { total: 710, cards: 200 },
      { total: 668, cards: 0 },
      { total: 0, cards: 0 },
    ];
    expect(unseenLeft(scope, 0)).toBe(510 + 668);
    // Not the 80 new words of the first two loaded batches.
    expect(unseenLeft(scope, 0)).not.toBe(80);
  });

  test("falls by one per new word graded, and never below 0", () => {
    const scope = [{ total: 3, cards: 1 }];
    expect(unseenLeft(scope, 1)).toBe(1);
    expect(unseenLeft(scope, 5)).toBe(0);
    // A list with more cards than its catalog (a shrunk catalog) adds nothing.
    expect(
      unseenLeft(
        [
          { total: 5, cards: 9 },
          { total: 4, cards: 0 },
        ],
        0,
      ),
    ).toBe(4);
  });

  test("a re-grade or a missed word met again is not a second new word", () => {
    const queue = [
      { kind: "due", listId: "a", term: "猫" },
      { kind: "new", listId: "a", term: "犬" },
      { kind: "new", listId: "b", term: "犬" },
      { kind: "again", listId: "a", term: "犬" },
    ];
    expect(countGradedNew(queue, [0])).toBe(0);
    expect(countGradedNew(queue, [1, 3])).toBe(1);
    expect(countGradedNew(queue, [1, 2, 3])).toBe(2);
    expect(countGradedNew(queue, new Map([[1, 0]]).keys())).toBe(1);
  });
});
