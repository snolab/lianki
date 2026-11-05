/**
 * The selection card's grade handle (lib/read/batch-grade.ts, batch-grade-server.ts):
 * which states offer what (due / new / unrecognised / not due), the skip
 * rule (only due cards and new items), a batch through the shared write
 * paths (the reader's sentence FSRS, /words' WordsD1Repo.review), and one
 * undo that returns every card to exactly its state before.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { WordsD1Repo } from "@/lib/repos/wordsD1";
import { BOOK_KIND, type BookMeta } from "@/lib/read/book";
import { readerBook, type ReaderBook } from "@/lib/read/reader-book";
import { sentenceId } from "@/lib/read/reader-api";
import { gradeFor, type WordContext } from "@/lib/read/reader-service";
import { cardsOfBook, type BookRef, type D1Batch } from "@/lib/read/reader-store";
import { bookHash } from "@/lib/read/units";
import type { BookCtx } from "@/lib/read/book-word-list";
import { formatInterval, previewInterval } from "@/lib/words/schedule";
import { gradeSentence } from "@/lib/read/sentence-cards";
import {
  batchOf,
  gradeIntervals,
  intervalLabel,
  handlePlan,
  hintParts,
  splitSentences,
  splitWords,
  wordState,
  type WordProbe,
} from "@/lib/read/batch-grade";
import { gradeBatch, probeBatch, undoBatch, type BatchCtx } from "@/lib/read/batch-grade-server";

const NOW = Date.parse("2026-11-05T03:00:00Z");
const probe = (o: Partial<WordProbe>): WordProbe => ({
  w: "chat",
  listId: "l1",
  term: "chat",
  due: "2026-11-04T00:00:00Z",
  reps: 3,
  ...o,
});

describe("states", () => {
  test("a word: due, new (a card never reviewed), no card, not due", () => {
    expect(wordState(probe({}), NOW)).toEqual({ kind: "due", isNew: false });
    expect(wordState(probe({ reps: 0, due: "2026-11-05T02:00:00Z" }), NOW)).toEqual({
      kind: "due",
      isNew: true,
    });
    expect(wordState(probe({ listId: null, term: null, due: null, reps: 0 }), NOW)).toEqual({
      kind: "nocard",
    });
    expect(wordState(undefined, NOW)).toEqual({ kind: "nocard" });
    expect(wordState(probe({ due: "2026-11-20T00:00:00Z" }), NOW)).toEqual({
      kind: "notDue",
      due: "2026-11-20T00:00:00Z",
    });
  });

  test("the plan: a due word gets the handle, a new word 制卡 first, a not-due word its due", () => {
    const p = (w: WordProbe) => handlePlan("word", { sentences: {}, words: [w] }, [], NOW);
    expect(p(probe({})).mode).toBe("grade");
    expect(p(probe({ listId: null, term: null, due: null, reps: 0, w: "zèbre" }))).toEqual({
      mode: "make",
      target: "word",
      w: "zèbre",
    });
    expect(p(probe({ due: "2026-11-20T00:00:00Z" }))).toEqual({
      mode: "notDue",
      target: "word",
      due: "2026-11-20T00:00:00Z",
    });
    // While the probe loads, and for a chapter or the book: nothing.
    expect(handlePlan("word", null, [], NOW).mode).toBe("none");
    expect(handlePlan("chapter", null, [], NOW).mode).toBe("none");
    // A paragraph: the swipe's own path, always.
    expect(handlePlan("para", null, [], NOW)).toMatchObject({ mode: "grade", target: "para" });
  });

  test("a phrase: its card's state, as a word's", () => {
    const pl = handlePlan(
      "phrase",
      { sentences: {}, words: [probe({ w: "tout à coup" })] },
      [],
      NOW,
    );
    expect(pl).toMatchObject({ mode: "grade", target: "phrase" });
  });
});

describe("the skip rule: only due cards and new items", () => {
  test("sentences: never graded or due are graded, not-due ones skipped", () => {
    const s = splitSentences(
      ["a", "b", "c", "a"],
      { a: null, b: "2026-11-04T00:00:00Z", c: "2026-12-01T00:00:00Z" },
      NOW,
    );
    expect(s).toEqual({ grade: ["a", "b"], skipped: ["c"] });
  });

  test("words: due and new graded, no card made, not due skipped; one card once", () => {
    const w = splitWords(
      [
        probe({ w: "chat" }),
        probe({ w: "chats" }), // the same card
        probe({ w: "chien", term: "chien", due: "2026-12-01T00:00:00Z" }),
        probe({ w: "loup", term: "loup", reps: 0 }),
        probe({ w: "zèbre", listId: null, term: null, due: null, reps: 0 }),
      ],
      NOW,
    );
    expect(w.grade.map((x) => x.w)).toEqual(["chat", "loup"]);
    expect(w.make.map((x) => x.w)).toEqual(["zèbre"]);
    expect(w.skipped.map((x) => x.w)).toEqual(["chien"]);
  });

  test("a range: Easy takes its due + new words along; another grade opens the review", () => {
    const pl = handlePlan(
      "range",
      {
        sentences: { s1: null, s2: "2026-12-01T00:00:00Z", s3: null },
        words: [probe({}), probe({ w: "zèbre", listId: null, term: null, due: null, reps: 0 })],
      },
      ["s1", "s2", "s3"],
      NOW,
    );
    if (pl.mode !== "grade") throw new Error("no handle");
    expect(pl.target).toBe("sentences");
    expect(pl.sentences).toEqual(["s1", "s3"]);
    expect(pl.skipped).toBe(1);
    const easy = batchOf(pl, 4);
    expect(easy.words.map((x) => x.w)).toEqual(["chat"]);
    expect(easy.make.map((x) => x.w)).toEqual(["zèbre"]);
    expect(easy.openReview).toBe(false);
    const good = batchOf(pl, 3);
    expect(good.words).toEqual([]);
    expect(good.openReview).toBe(true);
    expect(hintParts(pl, 4)).toEqual({ target: "sentences", n: 2, words: 2, skipped: 1 });
    expect(hintParts(pl, 3)).toEqual({ target: "sentences", n: 2, words: 0, skipped: 1 });
  });

  test("a single sentence never takes words along", () => {
    const pl = handlePlan("sentence", { sentences: { s1: null }, words: [] }, ["s1"], NOW);
    if (pl.mode !== "grade") throw new Error("no handle");
    expect(pl.target).toBe("sentence");
    expect(batchOf(pl, 4)).toEqual({ sentences: ["s1"], words: [], make: [], openReview: false });
  });

  test("nothing due or new: the handle is disabled, with its reason", () => {
    const pl = handlePlan(
      "range",
      { sentences: { s1: "2026-12-01T00:00:00Z" }, words: [] },
      ["s1"],
      NOW,
    );
    expect(pl).toMatchObject({ mode: "grade", disabled: "nothingDue", skipped: 1 });
  });
});

// ── Against the real schema ──

const LINES = ["Chapitre un", "Le chat dort. Le chien court.", "Un zèbre passe."];
const META: BookMeta = {
  kind: BOOK_KIND,
  v: 1,
  source: "epub",
  lang: "fr",
  chapters: [{ title: "Un", start: 0 }],
  headings: [0],
};
const EMAIL = "me@example.com";
const W: WordContext = { idx: new Map(), stats: { names: [] }, lem: null };
let d1: TestD1Database;
let db: D1Batch;
let book: ReaderBook;
let ref: BookRef;
let c: BatchCtx;
let repo: WordsD1Repo;
let deck: string;
const sid = (line: number, i: number) => sentenceId(book.hash, line, i);
const at = (iso: string) => new Date(iso);
const cardRow = (term: string) =>
  d1
    .prepare("SELECT card, card_due, reps, prev_card FROM word_cards WHERE email = ? AND term = ?")
    .bind(EMAIL, term)
    .first<{ card: string; card_due: string; reps: number; prev_card: string | null }>();
const sentenceRows = async () =>
  Object.fromEntries((await cardsOfBook(db, ref.userId, book.hash)).map((r) => [r.sid, r]));
const w = (x: string) => ({ w: x, ex: null, term: null, reading: null, back: null });

beforeEach(async () => {
  d1 = createTestD1(testSchema());
  db = d1 as unknown as D1Batch;
  book = readerBook(LINES, META, await bookHash(LINES));
  ref = { userId: "user-a", materialId: "mat-a", bookHash: book.hash, lang: "fr" };
  const bctx: BookCtx = { hash: book.hash, title: "Le Livre", lang: "fr", names: new Set() };
  c = { db, ref, email: EMAIL, book, w: W, bctx };
  repo = new WordsD1Repo(d1, EMAIL);
  deck = await repo.createList({ name: "French", lang: "fr", source: "fr-1000" });
  // "chat": due (reviewed a month ago); "chien": not due (reviewed Easy today).
  await repo.review(deck, [{ term: "chat", rating: 3 }], "2026-10-01", at("2026-10-01T00:00:00Z"));
  await repo.review(deck, [{ term: "chien", rating: 4 }], "2026-11-05", at("2026-11-05T02:00:00Z"));
});

describe("interval labels", () => {
  test("one value as /words writes it; a batch's span as a range", () => {
    const d = 86_400_000;
    expect(intervalLabel([3 * d, 3 * d], formatInterval)).toBe("3d");
    expect(intervalLabel([3 * d + 1000, 3 * d], formatInterval)).toBe("3d");
    expect(intervalLabel([d, 5 * d], formatInterval)).toBe("1d–5d");
    expect(intervalLabel([10 * 60_000, 2 * d], formatInterval)).toBe("10m–2d");
    expect(intervalLabel(null, formatInterval)).toBeNull();
  });
});

describe("one batch, the shared write paths, one undo", () => {
  test("the probe says what each sentence and word is, and writes nothing", async () => {
    const r = await probeBatch(c, [sid(1, 0)], [w("chat"), w("chien"), w("zèbre")], new Date(NOW));
    if (!r.ok) throw new Error(r.error);
    expect(r.res.sentences).toEqual({ [sid(1, 0)]: null });
    const by = Object.fromEntries(r.res.words.map((x) => [x.w, x]));
    expect(wordState(by.chat, NOW).kind).toBe("due");
    expect(wordState(by.chien, NOW).kind).toBe("notDue");
    expect(wordState(by.zèbre, NOW).kind).toBe("nocard");
    expect(by.chat.next?.[4]).toBeDefined();
    expect(r.res.sentenceNext[sid(1, 0)]?.[3]).toBeDefined();
    expect(await cardRow("zèbre")).toBeNull();
  });

  test("intervals: the same FSRS preview as /words for words, the sentence scheduler for sentences", async () => {
    const now = new Date(NOW);
    const r = await probeBatch(c, [sid(1, 0), sid(1, 1)], [w("chat"), w("zèbre")], now);
    if (!r.ok) throw new Error(r.error);
    const by = Object.fromEntries(r.res.words.map((x) => [x.w, x]));
    const list = (await repo.lists()).find((l) => l.id === deck)!;
    const chat = await cardRow("chat");
    for (const g of [1, 2, 3, 4] as const) {
      // A word: /words' own interval label (previewInterval: list params, no fuzz).
      const pl = handlePlan("word", { sentences: {}, words: [by.chat] }, [], NOW);
      if (pl.mode !== "grade") throw new Error("no handle");
      const iv = gradeIntervals(pl, r.res, NOW);
      expect(intervalLabel(iv[g], formatInterval)).toBe(
        previewInterval(chat!.card, g, list.params, now),
      );
      // A sentence: the reader's sentence scheduler.
      const sp = handlePlan("sentence", r.res, [sid(1, 0)], NOW);
      if (sp.mode !== "grade") throw new Error("no handle");
      const due = gradeSentence(null, g, now, false).due.getTime();
      expect(gradeIntervals(sp, r.res, NOW)[g]).toEqual([due - NOW, due - NOW]);
    }
    // A word with no card yet: a new card's interval.
    expect(by.zèbre.next?.[3]).toBeDefined();
    // A range: the span over its sentences, and its words on Easy.
    const rp = handlePlan("range", r.res, [sid(1, 0), sid(1, 1)], NOW);
    if (rp.mode !== "grade") throw new Error("no handle");
    const easy = gradeIntervals(rp, r.res, NOW)[4]!;
    const chatEasy = Date.parse(by.chat.next![4]!) - NOW;
    expect(easy[1]).toBeGreaterThanOrEqual(chatEasy);
    expect(easy[0]).toBeLessThanOrEqual(chatEasy);
    // A paragraph: its sentences.
    const pp = handlePlan("para", r.res, [], NOW);
    if (pp.mode !== "grade") throw new Error("no handle");
    expect(gradeIntervals(pp, r.res, NOW, [sid(1, 0), sid(1, 1)])[1]).not.toBeNull();
    expect(gradeIntervals(pp, null, NOW)[1]).toBeNull();
  });

  test("a word batch: graded through /words' review; undo restores the card exactly", async () => {
    const before = await cardRow("chat");
    const r = await gradeBatch(
      c,
      { clientId: "batch-word-1", rating: 2 },
      [w("chat")],
      new Date(NOW),
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.res.words.map((x) => x.term)).toEqual(["chat"]);
    const graded = await cardRow("chat");
    expect(graded!.reps).toBe(before!.reps + 1);
    const reviews = await d1
      .prepare("SELECT COUNT(*) AS n FROM word_reviews WHERE email = ? AND term = 'chat'")
      .bind(EMAIL)
      .first<{ n: number }>();
    expect(reviews!.n).toBe(2);
    // Sent long ago (no hold): the undo still restores it.
    const u = await undoBatch(c, "batch-word-1", "2026-11-05");
    expect(u).toEqual({ restored: 1, changed: 0 });
    const back = await cardRow("chat");
    expect(JSON.parse(back!.card)).toEqual(JSON.parse(before!.card));
    expect(back!.card_due).toBe(before!.card_due);
    expect(back!.reps).toBe(before!.reps);
    const after = await d1
      .prepare("SELECT COUNT(*) AS n FROM word_reviews WHERE email = ? AND term = 'chat'")
      .bind(EMAIL)
      .first<{ n: number }>();
    expect(after!.n).toBe(1);
    // Once: nothing is left to undo.
    expect(await undoBatch(c, "batch-word-1", "2026-11-05")).toBeNull();
  });

  test("a range batch: due + new sentences and words; not-due ones untouched; one undo", async () => {
    // Line 1's first sentence was graded Easy just now: not due.
    const g = await gradeFor(
      db,
      ref,
      book,
      W,
      { sentences: [sid(1, 0)], rating: 4, granularity: "sentence", clientId: "first-read-1" },
      at("2026-11-05T02:59:00Z"),
      false,
    );
    expect(g.ok).toBe(true);
    const s0 = await sentenceRows();
    const chien = await cardRow("chien");
    const r = await gradeBatch(
      c,
      { clientId: "batch-range-1", rating: 4, sentences: [sid(1, 0), sid(1, 1), sid(2, 0)] },
      [w("chat"), w("chien"), w("zèbre")],
      new Date(NOW),
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.res.sentences.sort()).toEqual([sid(1, 1), sid(2, 0)].sort());
    expect(r.res.skippedSentences).toBe(1);
    expect(r.res.words.map((x) => x.term).sort()).toEqual(["chat", "zèbre"]);
    expect(r.res.words.find((x) => x.term === "zèbre")?.made).toBe(true);
    expect(r.res.skippedWords).toBe(1);
    // The not-due sentence and word are untouched.
    const s1 = await sentenceRows();
    expect(s1[sid(1, 0)]).toEqual(s0[sid(1, 0)]);
    expect(await cardRow("chien")).toEqual(chien);
    expect((await cardRow("zèbre"))!.reps).toBe(1);

    // A retry with the same id grades nothing again.
    const again = await gradeBatch(
      c,
      { clientId: "batch-range-1", rating: 4, sentences: [sid(1, 1)] },
      [],
      new Date(NOW),
    );
    expect(again.ok && again.res.duplicate).toBe(true);

    const u = await undoBatch(c, "batch-range-1", "2026-11-05");
    expect(u).toEqual({ restored: 4, changed: 0 });
    const s2 = await sentenceRows();
    expect(Object.keys(s2)).toEqual([sid(1, 0)]);
    expect(s2[sid(1, 0)]).toEqual(s0[sid(1, 0)]);
    // The card the batch made is gone again; the others as they were.
    expect(await cardRow("zèbre")).toBeNull();
    expect(await cardRow("chien")).toEqual(chien);
    const reads = await d1
      .prepare("SELECT id FROM read_reviews WHERE user_id = ?")
      .bind(ref.userId)
      .all<{ id: string }>();
    expect(reads.results.map((x) => x.id)).toEqual(["first-read-1"]);
  });

  test("a sentence graded again since the batch keeps that later grade", async () => {
    const r = await gradeBatch(
      c,
      { clientId: "batch-sent-1", rating: 3, sentences: [sid(2, 0)] },
      [],
      new Date(NOW),
    );
    expect(r.ok).toBe(true);
    await gradeFor(
      db,
      ref,
      book,
      W,
      { sentences: [sid(2, 0)], rating: 1, granularity: "paragraph", clientId: "later-read-1" },
      new Date(NOW + 60_000),
      false,
    );
    const later = await sentenceRows();
    expect(await undoBatch(c, "batch-sent-1", undefined)).toEqual({ restored: 0, changed: 1 });
    expect(await sentenceRows()).toEqual(later);
  });

  test("a paragraph swipe's grade, already sent, is taken back exactly too", async () => {
    await gradeFor(
      db,
      ref,
      book,
      W,
      { sentences: [sid(1, 0)], rating: 3, granularity: "paragraph", clientId: "para-old-1" },
      at("2026-10-01T00:00:00Z"),
      false,
    );
    const s0 = await sentenceRows();
    await gradeFor(
      db,
      ref,
      book,
      W,
      {
        sentences: [sid(1, 0), sid(1, 1)],
        rating: 1,
        granularity: "paragraph",
        clientId: "para-new-1",
      },
      new Date(NOW),
      false,
    );
    expect(await undoBatch(c, "para-new-1", undefined)).toEqual({ restored: 2, changed: 0 });
    expect(await sentenceRows()).toEqual(s0);
  });

  test("validation: rating, client id, the book's own sentences", async () => {
    const bad = async (b: Record<string, unknown>) => {
      const r = await gradeBatch(c, b, [], new Date(NOW));
      return r.ok ? null : r.error;
    };
    expect(await bad({ clientId: "batch-x-1", rating: 5, sentences: [sid(1, 0)] })).toMatch(
      /rating/,
    );
    expect(await bad({ clientId: "x", rating: 3, sentences: [sid(1, 0)] })).toMatch(/clientId/);
    expect(
      await bad({ clientId: "batch-x-1", rating: 3, sentences: ["0000000000000000:1.0"] }),
    ).toMatch(/book/);
    expect(await bad({ clientId: "batch-x-1", rating: 3 })).toMatch(/nothing/);
  });
});
