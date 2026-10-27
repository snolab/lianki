import { describe, expect, test, beforeEach } from "bun:test";
import { testSchema } from "@/lib/d1/testSchema";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { WordsD1Repo } from "@/lib/repos/wordsD1";
import {
  DEFAULT_WORD_PARAMS,
  formatInterval,
  previewInterval,
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
      2,
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

test("list progress counts learning and mastered words", async () => {
  const d1 = createTestD1(testSchema());
  const repo = new WordsD1Repo(d1, "p@example.com");
  const id = await repo.createList({ name: "x", lang: "fr" });
  await repo.review(
    id,
    [
      { term: "a", rating: 1 },
      { term: "b", rating: 3 },
    ],
    "2026-10-27",
  );
  // Pretend "b" has graduated to a one-year interval.
  await d1
    .prepare(
      "UPDATE word_cards SET card = json_set(card, '$.scheduled_days', 365, '$.state', 2) WHERE term = 'b'",
    )
    .run();
  const list = await repo.getList(id);
  expect(list).toMatchObject({ cards: 2, learning: 1, mastered: 1 });
});

test("intervals read as 10m / 3d / 1y", () => {
  expect(formatInterval(30_000)).toBe("30s");
  expect(formatInterval(10 * 60_000)).toBe("10m");
  expect(formatInterval(5 * 3600_000)).toBe("5h");
  expect(formatInterval(3 * 86400_000)).toBe("3d");
  expect(formatInterval(120 * 86400_000)).toBe("4mo");
  expect(formatInterval(365 * 86400_000)).toBe("1y");
  expect(formatInterval(548 * 86400_000)).toBe("1.5y");
  // A new word rated Again comes back within the learning step.
  expect(previewInterval(null, 1, DEFAULT_WORD_PARAMS)).toBe("1m");
});

test("the cursor is what the client says, and concurrent screens add up", async () => {
  const d1 = createTestD1(testSchema());
  const repo = new WordsD1Repo(d1, "c@example.com");
  const id = await repo.createList({ name: "x", lang: "ja" });
  // Screen 1 holds catalog words 0, 2, 4 (1, 3 were moved to the next screen):
  // the client reports 1 as the first word it has not introduced yet.
  await repo.review(
    id,
    [0, 2, 4].map((i) => ({ term: `w${i}`, rating: 3 as const, newIndex: i })),
    "2026-10-27",
    new Date(),
    1,
  );
  // A flush sends no cursor and must leave it alone.
  await repo.review(id, [{ term: "w6", rating: 1 }], "2026-10-27");
  const list = await repo.getList(id);
  expect(list).toMatchObject({ cursor: 1, newToday: 4, cards: 4 });
});

test("lists keep the user's order, and new lists go last", async () => {
  const d1 = createTestD1(testSchema());
  const repo = new WordsD1Repo(d1, "o@example.com");
  const a = await repo.createList({ name: "a", lang: "fr" });
  const b = await repo.createList({ name: "b", lang: "fr" });
  await repo.reorder([{ id: b }, { id: a }]);
  const c = await repo.createList({ name: "c", lang: "fr" });
  expect((await repo.lists()).map((l) => l.name)).toEqual(["b", "a", "c"]);
  expect(c).toBeTruthy();
});

test("lists nest under groups; cycles are refused; deleting a group lifts its children", async () => {
  const d1 = createTestD1(testSchema());
  const repo = new WordsD1Repo(d1, "g@example.com");
  const g = await repo.createList({ name: "French", lang: "fr", source: "group:words" });
  const a = await repo.createList({ name: "a", lang: "fr", source: "fr-freq-1" });
  const b = await repo.createList({ name: "b", lang: "fr", source: "fr-freq-2" });
  await repo.reorder([{ id: g }, { id: a, parentId: g }, { id: b, parentId: g }]);
  expect((await repo.lists()).map((l) => [l.name, l.parentId])).toEqual([
    ["French", null],
    ["a", g],
    ["b", g],
  ]);
  // A group cannot go inside its own child.
  await repo.reorder([{ id: a }, { id: g, parentId: a }, { id: b, parentId: g }]);
  expect((await repo.getList(g))!.parentId).toBe(a);
  await repo.reorder([
    { id: g, parentId: a },
    { id: a, parentId: g },
  ]);
  expect((await repo.getList(a))!.parentId).toBeNull();
  await repo.reorder([{ id: g }, { id: a, parentId: g }]);
  await repo.deleteList(g);
  expect((await repo.getList(a))!.parentId).toBeNull();
});
