/**
 * A paragraph graded Easy grades its words Easy with it; any other grade opens
 * its word review when it has a word to review (owner, 2026-11-05 02:31 /
 * 02:32 JST; lib/read/book-word-list.ts easyPlan / gradeEasyWords,
 * lib/read/word-review.ts afterGrade, lib/read/reader-server.ts's hold).
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { testSchema } from "@/lib/d1/testSchema";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { WordsD1Repo } from "@/lib/repos/wordsD1";
import { easyPlan, gradeEasyWords, planWords, type BookCtx } from "@/lib/read/book-word-list";
import { afterGrade, planLeft } from "@/lib/read/word-review";
import { serverReaderData } from "@/lib/read/reader-server";
import type { ItemsResponse } from "@/lib/read/reader-api";
import { levelRating, sideRating, type SwipeRating } from "@/lib/words/swipe";

const EMAIL = "me@example.com";
const book: BookCtx = { hash: "h1", title: "Le Livre", lang: "fr", names: new Set(["marie"]) };

type Row = { list_id: string; term: string; reps: number; card: string; prev_card: string | null };

describe("the words an Easy paragraph grade takes (D1)", () => {
  let d1: TestD1Database;
  let repo: WordsD1Repo;
  let deck: string;
  const NOW = new Date("2026-11-05T00:00:00Z");
  const rows = () =>
    d1
      .raw()
      .prepare(
        "SELECT list_id, term, reps, card, prev_card FROM word_cards WHERE email = ? ORDER BY term",
      )
      .all(EMAIL) as Row[];
  const reviews = () =>
    (
      d1
        .raw()
        .prepare("SELECT term, rating FROM word_reviews WHERE email = ? ORDER BY rowid")
        .all(EMAIL) as { term: string; rating: number }[]
    ).map((r) => `${r.term}:${r.rating}`);

  beforeEach(async () => {
    d1 = createTestD1(testSchema());
    repo = new WordsD1Repo(d1, EMAIL);
    deck = await repo.createList({ name: "French 1000", lang: "fr", source: "fr-1000" });
    // "chat": reviewed long ago, due now. "chien": graded Easy yesterday, not due.
    await repo.review(deck, [{ term: "chat", rating: 3 }], "2026-10-01", new Date("2026-10-01"));
    await repo.review(deck, [{ term: "chien", rating: 3 }], "2026-10-01", new Date("2026-10-01"));
    await repo.review(deck, [{ term: "chien", rating: 4 }], "2026-11-04", new Date("2026-11-04"));
  });

  const words = [
    { w: "chat", ex: "Le chat dort." },
    { w: "chien", ex: "Le chien court." },
    { w: "loup", ex: "Le loup hurle.", back: "wolf" },
    { w: "marie", ex: "Marie lit." },
  ];

  it("due cards and words with no card; a card not due and a name are left out", async () => {
    const p = await easyPlan(d1, EMAIL, book, words, NOW);
    expect(p.due.map((d) => [d.term, d.listId === deck])).toEqual([["chat", true]]);
    expect(p.fresh.map((x) => x.w)).toEqual(["loup"]);
    expect(planWords(p)).toEqual(["chat", "loup"]);
    // Read-only: nothing made, nothing graded.
    expect(rows().map((r) => r.term)).toEqual(["chat", "chien"]);
  });

  it("grades each Easy on the app's own path; the new word carded in the book's list first", async () => {
    const before = rows();
    const out = await gradeEasyWords(d1, EMAIL, book, words, "2026-11-05", NOW);
    expect(out).toEqual({ graded: 2, made: 1 });
    const after = rows();
    const by = (rs: Row[], t: string) => rs.find((r) => r.term === t)!;
    // chat: one more review, Easy, its old card kept as prev_card (undo on /words).
    expect(by(after, "chat").reps).toBe(by(before, "chat").reps + 1);
    expect(by(after, "chat").prev_card).toBe(by(before, "chat").card);
    expect(Date.parse(JSON.parse(by(after, "chat").card).due)).toBeGreaterThan(NOW.getTime());
    // chien (not due): untouched, row for row.
    expect(by(after, "chien")).toEqual(by(before, "chien"));
    // loup: a card in the book's list, graded once.
    const list = (await repo.lists()).find((l) => l.source === "book:h1")!;
    expect(by(after, "loup").list_id).toBe(list.id);
    expect(by(after, "loup").reps).toBe(1);
    expect(list.size).toBe(1);
    expect(reviews().slice(-2)).toEqual(["chat:4", "loup:4"]);
    // No card for the name.
    expect(after.some((r) => r.term === "marie")).toBe(false);
  });

  it("is safe to send again (a retried request): nothing is graded twice", async () => {
    await gradeEasyWords(d1, EMAIL, book, words, "2026-11-05", NOW);
    const once = rows();
    const n = reviews().length;
    expect(await gradeEasyWords(d1, EMAIL, book, words, "2026-11-05", NOW)).toEqual({
      graded: 0,
      made: 0,
    });
    expect(rows()).toEqual(once);
    expect(reviews().length).toBe(n);
  });

  it("only his own cards: another account's are never read or graded", async () => {
    const other = new WordsD1Repo(d1, "other@example.com");
    const theirs = await other.createList({ name: "Theirs", lang: "fr", source: "x" });
    await other.review(theirs, [{ term: "loup", rating: 3 }], "2026-10-01", new Date("2026-10-01"));
    const p = await easyPlan(d1, EMAIL, book, words, NOW);
    // Their "loup" (due) is not his: for him it is still a new word.
    expect(p.fresh.map((x) => x.w)).toEqual(["loup"]);
    await gradeEasyWords(d1, EMAIL, book, words, "2026-11-05", NOW);
    const t = d1
      .raw()
      .prepare("SELECT reps FROM word_cards WHERE email = ? AND term = 'loup'")
      .get("other@example.com") as { reps: number };
    expect(t.reps).toBe(1);
  });
});

describe("after a paragraph grade", () => {
  it("Easy grades the words; Again, Hard and Good open the review only with a word in it", () => {
    for (const n of [0, 3, null]) expect(afterGrade(4, n)).toBe("easy");
    for (const r of [1, 2, 3] as const) {
      expect(afterGrade(r, 2)).toBe("review");
      expect(afterGrade(r, 0)).toBe("none");
      expect(afterGrade(r, null)).toBe("none");
    }
  });

  it("the Easy level is the far right by default, the far left mirrored", () => {
    const at = (k: number, mirror: boolean) => sideRating(levelRating(k), mirror);
    expect([-2, -1, 1, 2].map((k) => at(k, false))).toEqual([1, 2, 3, 4]);
    expect([-2, -1, 1, 2].map((k) => at(k, true))).toEqual([4, 3, 2, 1]);
  });

  it("counts leave out the words of an Easy grade still waiting to be sent", () => {
    expect(planLeft(["chat", "loup", "ours"], new Set(["loup"]))).toEqual(["chat", "ours"]);
  });
});

describe("the words ride the paragraph grade's Undo hold", () => {
  const H = "0123456789abcdef";
  const res: Pick<ItemsResponse, "items" | "bookHash" | "cards"> = {
    bookHash: H,
    items: [
      {
        key: "a",
        sentences: [[0, 0, 0, 4]],
        chapter: 0,
        words: 1,
        seconds: 1,
        fam: {
          tokens: 1,
          vocab: 0,
          coverage: 0,
          grade: 0,
          understood: 0,
          graded: 0,
          value: 0,
        },
        due: null,
      },
    ],
    cards: {},
  };
  const rbook = {
    id: "m1",
    lines: ["Le chat dort."],
    headings: new Set<number>(),
    chapterStarts: new Set([0]),
    lang: "fr",
  };
  const realFetch = globalThis.fetch;
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  afterEach(() => {
    globalThis.fetch = realFetch;
    sent.length = 0;
  });
  const serve = () =>
    (globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/items"))
        return new Response(JSON.stringify({ ...res, lang: "fr", granularity: "paragraph" }));
      sent.push({ url: u, body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response("{}");
    }) as unknown as typeof fetch);
  const words = { day: "2026-11-05", words: [{ w: "chat", ex: "Le chat dort." }] };
  const tick = () => new Promise((ok) => setTimeout(ok, 5));

  const graded = async (r: SwipeRating, hold = 10_000) => {
    serve();
    const d = serverReaderData("m1", H, hold);
    const item = (await d.load(rbook)).blocks[0];
    if (item.kind !== "item") throw new Error("item");
    let done = 0;
    const receipt = await d.grade(rbook, item, r, {
      easyWords: Promise.resolve(words),
      onSent: () => done++,
    });
    return { d, receipt, sentCount: () => done };
  };

  it("an undo inside the hold sends neither the grade nor its words", async () => {
    const { d, receipt } = await graded(4);
    expect(d.canUndo(receipt)).toBe(true);
    await d.undo(rbook, receipt);
    d.flush();
    await tick();
    expect(sent).toEqual([]);
  });

  it("past the hold: one request, the paragraph's Easy and its words together", async () => {
    const { receipt, sentCount, d } = await graded(4, 1);
    await tick();
    expect(d.canUndo(receipt)).toBe(false);
    expect(sent.map((s) => s.url)).toEqual(["/api/read/m1/grade"]);
    expect(sent[0].body).toMatchObject({ rating: 4, easyWords: words });
    expect(sentCount()).toBe(1);
  });

  it("any other grade sends no words", async () => {
    for (const r of [1, 2, 3] as const) {
      const { d } = await graded(r);
      d.flush();
      await tick();
      expect(sent.at(-1)?.body.rating).toBe(r);
      expect(sent.at(-1)?.body.easyWords).toBeUndefined();
    }
  });
});
