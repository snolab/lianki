import { describe, expect, test, beforeEach } from "bun:test";
import { testSchema } from "@/lib/d1/testSchema";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { WordsD1Repo } from "@/lib/repos/wordsD1";
import {
  DEFAULT_WORD_PARAMS,
  dayKey,
  newRemaining,
  normalizeParams,
  reviewWord,
} from "@/lib/words/schedule";

describe("word params", () => {
  test("defaults fill in anything missing or invalid", () => {
    expect(normalizeParams(undefined)).toEqual(DEFAULT_WORD_PARAMS);
    const p = normalizeParams({ retention: 2, learningSteps: ["bogus"], newPerDay: 20 });
    expect(p.retention).toBe(0.97);
    expect(p.learningSteps).toEqual(DEFAULT_WORD_PARAMS.learningSteps);
    expect(p.newPerDay).toBe(20);
  });

  test("a new word rated Again comes back within minutes, not days", () => {
    const now = new Date("2026-10-27T10:00:00Z");
    const { card } = reviewWord(null, 1, now, DEFAULT_WORD_PARAMS);
    expect(card.due.getTime() - now.getTime()).toBeLessThanOrEqual(5 * 60_000);
  });

  test("daily new-word budget resets on a new day", () => {
    const p = normalizeParams({ newPerDay: 10 });
    expect(newRemaining({ new_day: "2026-10-27", new_today: 4 }, p, "2026-10-27")).toBe(6);
    expect(newRemaining({ new_day: "2026-10-26", new_today: 10 }, p, "2026-10-27")).toBe(10);
    expect(dayKey("nope", new Date("2026-10-27T01:00:00Z"))).toBe("2026-10-27");
  });
});

describe("WordsD1Repo", () => {
  let d1: TestD1Database;
  let repo: WordsD1Repo;
  beforeEach(() => {
    d1 = createTestD1(testSchema());
    repo = new WordsD1Repo(d1, "a@example.com");
  });

  test("a list starts empty and words get cards only when reviewed", async () => {
    const id = await repo.createList({ name: "French 1", lang: "fr", source: "fr-freq-1" });
    const list = await repo.getList(id);
    expect(list).toMatchObject({ name: "French 1", cursor: 0, cards: 0, due: 0 });

    const now = new Date("2026-10-27T10:00:00Z");
    const res = await repo.review(
      id,
      [
        { term: "être", back: "to be", rating: 3, newIndex: 0 },
        { term: "avoir", back: "to have", rating: 1, newIndex: 1 },
      ],
      "2026-10-27",
      now,
    );
    expect(res!.cards).toHaveLength(2);
    const after = await repo.getList(id, now);
    expect(after).toMatchObject({ cursor: 2, cards: 2, newToday: 2 });
    expect(res!.newRemaining).toBe(DEFAULT_WORD_PARAMS.newPerDay - 2);

    // "avoir" (Again) is due again within minutes; "être" (Good) is not yet.
    const soon = new Date(now.getTime() + 10 * 60_000);
    const due = await repo.dueCards(id, soon);
    expect(due.map((c) => c.term)).toContain("avoir");
    expect((await repo.knownTerms(id, ["être", "faire"])).has("être")).toBe(true);
  });

  test("the same word twice in one batch builds on the first rating", async () => {
    const id = await repo.createList({ name: "x", lang: "fr" });
    const res = await repo.review(
      id,
      [
        { term: "chat", back: "cat", rating: 1, newIndex: 0 },
        { term: "chat", rating: 3 },
      ],
      "2026-10-27",
    );
    expect(res!.cards).toEqual([expect.objectContaining({ term: "chat", reps: 2, back: "cat" })]);
    expect((await repo.getList(id))!.newToday).toBe(1);
  });

  test("lists are per user and deleting one removes its cards", async () => {
    const id = await repo.createList({ name: "x", lang: "fr" });
    await repo.review(id, [{ term: "chat", rating: 3 }], "2026-10-27");
    expect(await new WordsD1Repo(d1, "b@example.com").lists()).toEqual([]);
    await repo.deleteList(id);
    expect(await repo.lists()).toEqual([]);
    const left = await d1.prepare("SELECT COUNT(*) AS n FROM word_cards").first<{ n: number }>();
    expect(left!.n).toBe(0);
  });

  test("reviewing an unknown list returns null", async () => {
    expect(await repo.review("nope", [{ term: "a", rating: 3 }], "2026-10-27")).toBeNull();
  });
});
