/**
 * A paragraph graded Easy grades its words Easy with it (a GradeRequest with
 * `easyWords`; lib/read/book-word-list.ts easyPlan / gradeEasyWords,
 * lib/read/reader-server.ts's hold), and what each swipe level does after the
 * grade (lib/read/review-scope.ts afterGrade; owner, 2026-11-08, card
 * d2cf3080): Again / Hard open a review, Good nothing, Easy the Easy batch.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { testSchema } from "@/lib/d1/testSchema";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { WordsD1Repo } from "@/lib/repos/wordsD1";
import type { BookCtx } from "@/lib/read/book-word-list";
import { gradeWords, planWords, undoBatch } from "@/lib/read/batch-grade-server";
import { BOOK_KIND, type BookMeta } from "@/lib/read/book";
import { readerBook, type ReaderBook } from "@/lib/read/reader-book";
import { sentenceId } from "@/lib/read/reader-api";
import { gradeFor, type WordContext } from "@/lib/read/reader-service";
import {
  cardsOfBook,
  undoWordsStatement,
  type BookRef,
  type D1Batch,
} from "@/lib/read/reader-store";
import { bookHash } from "@/lib/read/units";
import { afterGrade } from "@/lib/read/review-scope";
import { planLeft } from "@/lib/read/word-review";
import { serverReaderData } from "@/lib/read/reader-server";
import type { ItemsResponse } from "@/lib/read/reader-api";
import { levelRating, sideRating, type SwipeRating } from "@/lib/words/swipe";

const EMAIL = "me@example.com";
const NOW = new Date("2026-11-05T03:00:00Z");
const LINES = ["Chapitre un", "Le chat dort. Le chien court. Le loup hurle.", "Marie lit."];
const META: BookMeta = {
  kind: BOOK_KIND,
  v: 1,
  source: "epub",
  lang: "fr",
  chapters: [{ title: "Un", start: 0 }],
  headings: [0],
};
const W: WordContext = { idx: new Map(), stats: { names: [] }, lem: null };

type Row = { list_id: string; term: string; reps: number; card: string; prev_card: string | null };

describe("an Easy paragraph grade takes its words (D1, the batch path)", () => {
  let d1: TestD1Database;
  let db: D1Batch;
  let repo: WordsD1Repo;
  let deck: string;
  let book: ReaderBook;
  let ref: BookRef;
  let bctx: BookCtx;
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
    db = d1 as unknown as D1Batch;
    book = readerBook(LINES, META, await bookHash(LINES));
    ref = { userId: "user-a", materialId: "mat-a", bookHash: book.hash, lang: "fr" };
    bctx = { hash: book.hash, title: "Le Livre", lang: "fr", names: new Set(["marie"]) };
    repo = new WordsD1Repo(d1, EMAIL);
    deck = await repo.createList({ name: "French 1000", lang: "fr", source: "fr-1000" });
    // "chat": reviewed long ago, due now. "chien": graded Easy hours ago, not due.
    await repo.review(deck, [{ term: "chat", rating: 3 }], "2026-10-01", new Date("2026-10-01"));
    await repo.review(deck, [{ term: "chien", rating: 3 }], "2026-10-01", new Date("2026-10-01"));
    await repo.review(deck, [{ term: "chien", rating: 4 }], "2026-11-05", new Date("2026-11-05"));
  });

  const words = [
    { w: "chat", ex: "Le chat dort." },
    { w: "chien", ex: "Le chien court." },
    { w: "loup", ex: "Le loup hurle.", back: "wolf" },
    { w: "marie", ex: "Marie lit." },
  ];
  const c = () => ({ db, email: EMAIL, bctx });
  /** The /grade route's Easy path: the paragraph's grade, then its words in its undo record. */
  const easy = async (id: string) => {
    const r = await gradeFor(
      db,
      ref,
      book,
      W,
      {
        sentences: [sentenceId(book.hash, 1, 0)],
        rating: 4,
        granularity: "paragraph",
        clientId: id,
      },
      NOW,
      false,
    );
    if (!r.ok) throw new Error(r.error);
    const g = await gradeWords(c(), words, 4, "2026-11-05", NOW);
    await db.batch([
      undoWordsStatement(db, ref, id, JSON.stringify(g.undoWords), NOW.toISOString()),
    ]);
    return g;
  };

  it("the plan: due cards and words with no card; a card not due and a name are left out", async () => {
    expect(await planWords(c(), words, NOW)).toEqual(["chat", "loup"]);
    // Read-only: nothing made, nothing graded.
    expect(rows().map((r) => r.term)).toEqual(["chat", "chien"]);
  });

  it("grades each Easy on /words' own path; the new word carded in the book's list first", async () => {
    const before = rows();
    const g = await easy("easy-para-0001");
    expect(g.outWords.map((x) => [x.term, x.made])).toEqual([
      ["chat", false],
      ["loup", true],
    ]);
    const after = rows();
    const by = (rs: Row[], t: string) => rs.find((r) => r.term === t)!;
    expect(by(after, "chat").reps).toBe(by(before, "chat").reps + 1);
    expect(Date.parse(JSON.parse(by(after, "chat").card).due)).toBeGreaterThan(NOW.getTime());
    // chien (not due): untouched, row for row.
    expect(by(after, "chien")).toEqual(by(before, "chien"));
    const list = (await repo.lists()).find((l) => l.source === `book:${book.hash}`)!;
    expect(by(after, "loup").list_id).toBe(list.id);
    expect(by(after, "loup").reps).toBe(1);
    expect(reviews().slice(-2)).toEqual(["chat:4", "loup:4"]);
    expect(after.some((r) => r.term === "marie")).toBe(false);
    // Again (a retried request): nothing is graded twice.
    const n = reviews().length;
    expect((await gradeWords(c(), words, 4, "2026-11-05", NOW)).outWords).toEqual([]);
    expect(reviews().length).toBe(n);
  });

  it("taken back once sent: the paragraph and every word exactly as before, made cards gone", async () => {
    const cards0 = rows();
    const s0 = await cardsOfBook(db, ref.userId, book.hash);
    await easy("easy-para-0002");
    const u = await undoBatch({ db, ref, email: EMAIL, bctx }, "easy-para-0002", "2026-11-05");
    expect(u).toEqual({ restored: 3, changed: 0 });
    expect(rows()).toEqual(
      cards0.map((r) => ({ ...r, prev_card: r.term === "chat" ? "" : r.prev_card })),
    );
    expect(JSON.parse(rows().find((r) => r.term === "chat")!.card)).toEqual(
      JSON.parse(cards0.find((r) => r.term === "chat")!.card),
    );
    expect(await cardsOfBook(db, ref.userId, book.hash)).toEqual(s0);
    expect((await repo.lists()).find((l) => l.source === `book:${book.hash}`)?.size ?? 0).toBe(0);
  });

  it("only his own cards: another account's are never read or graded", async () => {
    const other = new WordsD1Repo(d1, "other@example.com");
    const theirs = await other.createList({ name: "Theirs", lang: "fr", source: "x" });
    await other.review(theirs, [{ term: "loup", rating: 3 }], "2026-10-01", new Date("2026-10-01"));
    expect(await planWords(c(), words, NOW)).toEqual(["chat", "loup"]);
    await easy("easy-para-0003");
    const t = d1
      .raw()
      .prepare("SELECT reps FROM word_cards WHERE email = ? AND term = 'loup'")
      .get("other@example.com") as { reps: number };
    expect(t.reps).toBe(1);
  });
});

describe("after a paragraph grade (lib/read/review-scope.ts afterGrade)", () => {
  it("far left reviews the paragraph, far right grades its words Easy; Good opens nothing", () => {
    const at = (k: number, mirror: boolean) =>
      afterGrade(sideRating(levelRating(k), mirror) as SwipeRating);
    expect([-2, -1, 1, 2].map((k) => at(k, false))).toEqual(["para", "upto", "none", "easy"]);
    expect([-2, -1, 1, 2].map((k) => at(k, true))).toEqual(["easy", "none", "upto", "para"]);
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
