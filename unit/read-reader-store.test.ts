// Reader v2's store and answers (lib/read/reader-store.ts, reader-service.ts)
// against the real schema: FSRS per sentence, no history lost when the
// granularity changes, idempotent grades, synced position, the exposure log,
// notes with history — and every row scoped to its user.
import { beforeEach, describe, expect, it } from "bun:test";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import type { BookMeta } from "@/lib/read/book";
import { BOOK_KIND } from "@/lib/read/book";
import { chapterOf, hashOf, readerBook, type ReaderBook } from "@/lib/read/reader-book";
import { sentenceId } from "@/lib/read/reader-api";
import {
  dueFor,
  familiarityFor,
  gradeFor,
  itemsFor,
  noteFor,
  parseGranularity,
  type WordContext,
} from "@/lib/read/reader-service";
import {
  cardsOfBook,
  chunks,
  deleteNote,
  deleteReaderRows,
  exposureRow,
  getProgress,
  lastSeen,
  notesInLines,
  putProgress,
  readSamples,
  recentProgress,
  recordExposures,
  reviewsInLines,
  saveContentHash,
  updateNote,
  type BookRef,
  type D1Batch,
} from "@/lib/read/reader-store";
import { bookHash, sentenceIndex } from "@/lib/read/units";
import { cardIndex, normWord, wordsOf } from "@/lib/read/words";

const LINES = [
  "Chapitre un",
  "Il était une fois un roi. Le roi avait une fille.",
  "Elle aimait les livres.",
  "Chapitre deux",
  "Un jour, elle partit. Elle ne revint jamais.",
];
const META: BookMeta = {
  kind: BOOK_KIND,
  v: 1,
  source: "epub",
  lang: "fr",
  chapters: [
    { title: "Un", start: 0 },
    { title: "Deux", start: 3 },
  ],
  headings: [0, 3],
};

let d1: TestD1Database;
let db: D1Batch;
let book: ReaderBook;
let A: BookRef;
let B: BookRef;
const W: WordContext = { idx: new Map(), stats: { names: [] }, lem: null };
const NOW = new Date("2026-11-03T12:00:00Z");
const sid = (line: number, i: number) => sentenceId(book.hash, line, i);

beforeEach(async () => {
  d1 = createTestD1(testSchema());
  db = d1 as unknown as D1Batch;
  const hash = await bookHash(LINES);
  book = readerBook(LINES, META, hash);
  A = { userId: "user-a", materialId: "mat-a", bookHash: hash, lang: book.lang };
  B = { userId: "user-b", materialId: "mat-b", bookHash: hash, lang: book.lang };
});

describe("json_each statements stay small", () => {
  it("rows go in chunks", () => {
    expect(chunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunks([])).toEqual([]);
  });
});

describe("the gate", () => {
  it("granularity is one of three", () => {
    expect(parseGranularity("time")).toBe("time");
    expect(parseGranularity("page")).toBeNull();
    expect(parseGranularity(3)).toBeNull();
  });

  it("the stored hash is used when there is one", async () => {
    expect(await hashOf({ lines: LINES, contentHash: "ffffffffffffffff" })).toBe(
      "ffffffffffffffff",
    );
    expect(await hashOf({ lines: LINES })).toBe(book.hash);
  });

  it("chapters and their lines", () => {
    expect(book.chapters).toEqual([
      [0, 3],
      [3, 5],
    ]);
    expect(chapterOf(book, 4)).toBe(1);
    expect(book.lang).toBe("fr");
  });
});

describe("grading: FSRS on each sentence", () => {
  it("one swipe grades every sentence of the item; another granularity keeps their history", async () => {
    const r = await gradeFor(
      db,
      A,
      book,
      W,
      {
        sentences: [sid(1, 0), sid(1, 1)],
        rating: 3,
        granularity: "paragraph",
        clientId: "grade-001",
      },
      NOW,
      false,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.res.cards).sort()).toEqual([sid(1, 0), sid(1, 1)]);
    expect(r.res.cards[sid(1, 0)].reps).toBe(1);
    expect(r.res.duplicate).toBe(false);

    // Now one sentence alone, a day later: its card goes on from reps 1.
    const later = new Date(NOW.getTime() + 86_400_000);
    const s = await gradeFor(
      db,
      A,
      book,
      W,
      { sentences: [sid(1, 1)], rating: 4, granularity: "sentence", clientId: "grade-002" },
      later,
      false,
    );
    expect(s.ok && s.res.cards[sid(1, 1)].reps).toBe(2);
    expect(s.ok && s.res.cards[sid(1, 1)].lastRating).toBe(4);
    const rows = await cardsOfBook(db, A.userId, book.hash);
    expect(rows.length).toBe(2);
    const reviews = await reviewsInLines(db, A.userId, book.hash, 0, 5);
    expect(reviews.map((x) => [x.granularity, x.count])).toEqual([
      ["paragraph", 2],
      ["sentence", 1],
    ]);
  });

  it("a retried grade (same client id) changes nothing", async () => {
    const body = {
      sentences: [sid(2, 0)],
      rating: 2 as const,
      granularity: "sentence" as const,
      clientId: "retry-me-1",
    };
    await gradeFor(db, A, book, W, body, NOW, false);
    const again = await gradeFor(db, A, book, W, body, new Date(NOW.getTime() + 60_000), false);
    expect(again.ok && again.res.duplicate).toBe(true);
    expect(again.ok && again.res.cards[sid(2, 0)].reps).toBe(1);
    expect((await reviewsInLines(db, A.userId, book.hash, 0, 5)).length).toBe(1);
  });

  it("a grade racing another on the same sentences is computed again, no step lost", async () => {
    await gradeFor(
      db,
      A,
      book,
      W,
      { sentences: [sid(2, 0)], rating: 3, granularity: "sentence" },
      NOW,
      false,
    );
    let raced = false;
    const racy = Object.create(db) as D1Batch;
    racy.batch = async (stmts) => {
      if (!raced) {
        raced = true;
        // Another device's grade lands between this one's read and its write.
        await gradeFor(
          db,
          A,
          book,
          W,
          { sentences: [sid(2, 0)], rating: 3, granularity: "sentence" },
          new Date(NOW.getTime() + 1000),
          false,
        );
      }
      return db.batch(stmts);
    };
    const r = await gradeFor(
      racy,
      A,
      book,
      W,
      { sentences: [sid(2, 0)], rating: 3, granularity: "sentence" },
      new Date(NOW.getTime() + 2000),
      false,
    );
    expect(raced).toBe(true);
    expect(r.ok && r.res.cards[sid(2, 0)].reps).toBe(3);
    expect((await reviewsInLines(db, A.userId, book.hash, 0, 5)).length).toBe(3);
  });

  it("a retried grade returns the note saved with it", async () => {
    const body = {
      sentences: [sid(2, 0)],
      rating: 3 as const,
      granularity: "sentence" as const,
      clientId: "noted-retry",
      note: "vu",
    };
    await gradeFor(db, A, book, W, body, NOW, false);
    const again = await gradeFor(db, A, book, W, body, NOW, false);
    expect(again.ok && again.res.duplicate).toBe(true);
    expect(again.ok && again.res.note?.text).toBe("vu");
    expect((await notesInLines(db, A.userId, book.hash, 0, 5)).length).toBe(1);
  });

  it("the same client id from another user is that user's own grade", async () => {
    const body = {
      sentences: [sid(2, 0)],
      rating: 3 as const,
      granularity: "sentence" as const,
      clientId: "same-id-xx",
    };
    await gradeFor(db, A, book, W, body, NOW, false);
    const b = await gradeFor(db, B, book, W, body, NOW, false);
    expect(b.ok && b.res.duplicate).toBe(false);
    expect((await cardsOfBook(db, B.userId, book.hash)).length).toBe(1);
  });

  it("refuses sentences of another book, bad ratings, granularities and bodies", async () => {
    const bad = [
      null,
      { sentences: [sid(1, 0)], rating: 5, granularity: "sentence" },
      { sentences: [sid(1, 0)], rating: 3, granularity: "page" },
      { sentences: [], rating: 3, granularity: "sentence" },
      { sentences: ["0000000000000000:1.0"], rating: 3, granularity: "sentence" },
      { sentences: [sid(1, 9)], rating: 3, granularity: "sentence" },
      { sentences: Array(5001).fill(sid(1, 0)), rating: 3, granularity: "sentence" },
    ];
    for (const b of bad) expect((await gradeFor(db, A, book, W, b as never, NOW)).ok).toBe(false);
    expect((await cardsOfBook(db, A.userId, book.hash)).length).toBe(0);
  });

  it("a read time is kept only when it makes sense; it feeds the bounds", async () => {
    const shownAt = new Date(NOW.getTime() - 4000).toISOString();
    await gradeFor(
      db,
      A,
      book,
      W,
      {
        sentences: [sid(2, 0)],
        rating: 3,
        granularity: "sentence",
        shownAt,
        swipedAt: NOW.toISOString(),
      },
      NOW,
    );
    await gradeFor(
      db,
      A,
      book,
      W,
      {
        sentences: [sid(1, 0)],
        rating: 3,
        granularity: "sentence",
        shownAt: NOW.toISOString(),
        swipedAt: shownAt,
      },
      NOW,
    );
    const samples = await readSamples(db, A.userId, book.lang);
    expect(samples).toEqual([{ words: 4, dwellMs: 4000 }]);
    expect(await readSamples(db, B.userId, book.lang)).toEqual([]);
  });

  it("a note with the grade is tied to that read", async () => {
    const r = await gradeFor(
      db,
      A,
      book,
      W,
      {
        sentences: [sid(2, 0)],
        rating: 3,
        granularity: "sentence",
        clientId: "with-note-1",
        note: "  compris  ",
      },
      NOW,
    );
    expect(r.ok && r.res.note?.text).toBe("compris");
    expect(r.ok && r.res.note?.reviewId).toBe("with-note-1");
  });
});

describe("items and familiarity", () => {
  it("items of a chapter carry the user's states, only theirs", async () => {
    await gradeFor(
      db,
      A,
      book,
      W,
      { sentences: [sid(1, 0), sid(1, 1)], rating: 3, granularity: "paragraph" },
      NOW,
      false,
    );
    const a = await itemsFor(db, A, book, W, { granularity: "sentence", from: 1, to: null });
    expect(a.chapters).toEqual([0]);
    expect(a.lines).toEqual([0, 3]);
    expect(a.bounds.boundsSource).toBe("prior");
    expect(Object.keys(a.cards).sort()).toEqual([sid(1, 0), sid(1, 1)]);
    expect(a.items.some((i) => i.due)).toBe(true);
    // Every sentence of the chapter in exactly one item.
    const all = a.items.flatMap((i) => i.sentences.map(([l, s]) => `${l}.${s}`));
    expect(all).toEqual(["0.0", "1.0", "1.1", "2.0"]);
    const b = await itemsFor(db, B, book, W, { granularity: "paragraph", from: 0, to: 5 });
    expect(b.chapters).toEqual([0, 1]);
    expect(Object.keys(b.cards)).toEqual([]);
    expect(b.items.every((i) => i.fam.graded === 0 && i.due === null)).toBe(true);
    const t = await itemsFor(db, B, book, W, { granularity: "time", from: 0, to: 5, seconds: 60 });
    expect(t.bounds.targetSeconds).toBe(60);
    expect(t.items.length).toBe(2); // one per chapter
  });

  it("familiarity: known words alone are not familiar; the pass needs both lines", async () => {
    const all = LINES.flatMap((l) => wordsOf(l, "fr"));
    const known: WordContext = {
      // Every word mastered (a year's interval).
      idx: cardIndex(
        all.map((w) => ({
          term: w,
          reading: null,
          lang: "fr",
          stability: 400,
          interval: 400,
          cap: 365,
        })),
      ),
      stats: { names: [] },
      lem: null,
    };
    let f = await familiarityFor(db, A, book, known);
    expect(f.book.coverage).toBe(1);
    expect(f.book.vocab).toBe(1);
    expect(f.book.value).toBe(0);
    expect(f.pass).toMatchObject({ words: true, understood: false, passed: false });
    const every = [];
    for (let i = 0; i < book.sentences.n; i++) {
      const l = book.sentences.refs[i * 4];
      every.push(sentenceId(book.hash, l, book.sentences.refs[i * 4 + 1]));
    }
    await gradeFor(
      db,
      A,
      book,
      known,
      { sentences: every, rating: 3, granularity: "time" },
      NOW,
      false,
    );
    f = await familiarityFor(db, A, book, known);
    expect(f.book.understood).toBe(1);
    expect(f.book.graded).toBe(1);
    expect(f.book.value).toBeGreaterThan(0);
    expect(f.pass.passed).toBe(true);
    expect(f.chapters.length).toBe(2);
    // B has read nothing.
    expect((await familiarityFor(db, B, book, known)).pass.understood).toBe(false);
  });

  it("due: graded sentences come back in reading order", async () => {
    await gradeFor(
      db,
      A,
      book,
      W,
      { sentences: [sid(4, 1), sid(1, 0)], rating: 1, granularity: "sentence" },
      NOW,
      false,
    );
    const later = new Date(NOW.getTime() + 3_600_000);
    const d = await dueFor(db, A, book, later);
    expect(d.due.map((x) => x.sid)).toEqual([sid(1, 0), sid(4, 1)]);
    expect((await dueFor(db, B, book, later)).due).toEqual([]);
    const now = await dueFor(db, A, book, NOW);
    expect(now.due).toEqual([]);
    expect(now.next).not.toBeNull();
  });

  it("a card whose sentence moved (segmenter update) follows its text on the same line", async () => {
    await gradeFor(
      db,
      A,
      book,
      W,
      { sentences: [sid(1, 1)], rating: 3, granularity: "sentence" },
      NOW,
      false,
    );
    // Pretend an older segmenter stored it as index 0 of line 1.
    await d1.raw().exec(`UPDATE read_sentence_cards SET idx = 0, sid = '${sid(1, 0)}'`);
    const a = await itemsFor(db, A, book, W, { granularity: "sentence", from: 0, to: 3 });
    expect(Object.keys(a.cards)).toEqual([sid(1, 1)]);
  });
});

describe("progress: synced position", () => {
  it("newest anchor wins, the high-water line only grows and reports what it moved over", async () => {
    let p = await putProgress(
      db,
      A.userId,
      A.materialId,
      { line: 2, offset: 0.5, at: "2026-11-03T10:00:00Z", highLine: 2 },
      NOW,
    );
    expect(p.anchor).toMatchObject({ line: 2, offset: 0.5 });
    expect(p.advanced).toEqual([0, 3]);
    // An older anchor from another device does not move it back; high stays.
    p = await putProgress(
      db,
      A.userId,
      A.materialId,
      { line: 0, offset: 0, at: "2026-11-03T09:00:00Z", highLine: 1 },
      NOW,
    );
    expect(p.anchor?.line).toBe(2);
    expect(p.highLine).toBe(2);
    expect(p.advanced).toBeUndefined();
    p = await putProgress(
      db,
      A.userId,
      A.materialId,
      { line: 4, offset: 0.1, at: "2026-11-03T11:00:00Z" },
      NOW,
    );
    expect(p.anchor?.line).toBe(4);
    expect(p.highLine).toBe(2);
    p = await putProgress(
      db,
      A.userId,
      A.materialId,
      { line: 4, offset: 0.2, at: "2026-11-03T11:01:00Z", highLine: 4 },
      NOW,
    );
    expect(p.advanced).toEqual([3, 5]);
    expect(await getProgress(db, B.userId, A.materialId)).toEqual({ anchor: null, highLine: null });
  });

  it("recent positions, newest anchor first, only the user's own (Continue reading)", async () => {
    expect(await recentProgress(db, A.userId, 5)).toEqual([]);
    const put = (userId: string, materialId: string, line: number, at: string) =>
      putProgress(db, userId, materialId, { line, offset: 0, at }, NOW);
    await put(A.userId, "mat-old", 1, "2026-11-03T08:00:00Z");
    await put(A.userId, "mat-new", 3, "2026-11-03T10:00:00Z");
    await put(B.userId, "mat-b", 2, "2026-11-03T11:00:00Z");
    expect(await recentProgress(db, A.userId, 5)).toEqual([
      { materialId: "mat-new", line: 3, at: "2026-11-03T10:00:00Z" },
      { materialId: "mat-old", line: 1, at: "2026-11-03T08:00:00Z" },
    ]);
    expect((await recentProgress(db, A.userId, 1)).map((r) => r.materialId)).toEqual(["mat-new"]);
  });
});

describe("exposures: a log only", () => {
  const norm = (w: string) => normWord(w, "fr");
  const words = (s: string) => {
    const [, rest] = s.split(":");
    const [l, i] = rest.split(".").map(Number);
    const at = sentenceIndex(book.sentences, l, i);
    const r = book.sentences.refs;
    return wordsOf(LINES[l].slice(r[at * 4 + 2], r[at * 4 + 3]), "fr");
  };

  it("seen sentences count their words once a day; resends are duplicates; word cards untouched", async () => {
    const ev = [
      exposureRow({ kind: "seen", sid: sid(2, 0), at: NOW.toISOString() }, NOW, norm)!,
      exposureRow(
        { kind: "lookup", sid: sid(2, 0), word: "Livres", at: NOW.toISOString() },
        NOW,
        norm,
      )!,
    ];
    expect(await recordExposures(db, A, ev, words)).toEqual({ accepted: 2, duplicates: 0 });
    expect(await recordExposures(db, A, ev, words)).toEqual({ accepted: 0, duplicates: 2 });
    const rows = d1
      .raw()
      .prepare("SELECT word, seen, explicit FROM read_exposures WHERE user_id = ? ORDER BY word")
      .all("user-a");
    expect(rows).toContainEqual({ word: "livres", seen: 1, explicit: 1 });
    expect(rows).toContainEqual({ word: "aimait", seen: 1, explicit: 0 });
    expect((await lastSeen(db, A.userId, "fr", ["livres", "roi"])).get("livres")).toBe(
      NOW.toISOString(),
    );
    expect((await lastSeen(db, B.userId, "fr", ["livres"])).size).toBe(0);
    expect(d1.raw().prepare("SELECT COUNT(*) AS n FROM word_cards").get()).toEqual({ n: 0 });
  });

  it("two concurrent resends of the same events count once", async () => {
    const ev = [exposureRow({ kind: "seen", sid: sid(2, 0), at: NOW.toISOString() }, NOW, norm)!];
    const both = await Promise.all([
      recordExposures(db, A, ev, words),
      recordExposures(db, A, ev, words),
    ]);
    expect(both[0].accepted + both[1].accepted).toBe(1);
    const rows = d1
      .raw()
      .prepare("SELECT seen FROM read_exposures WHERE user_id = ? AND word = 'livres'")
      .all("user-a");
    expect(rows).toEqual([{ seen: 1 }]);
  });

  it("checks events: kinds, words, and times kept within the last week", () => {
    expect(exposureRow({ kind: "glance" as never, sid: "x", at: "" }, NOW, norm)).toBeNull();
    expect(exposureRow({ kind: "lookup", sid: "x", at: "" }, NOW, norm)).toBeNull();
    expect(exposureRow({ kind: "seen", at: "" } as never, NOW, norm)).toBeNull();
    expect(exposureRow({ kind: "lookup", sid: "x", word: "42", at: "" }, NOW, norm)).toBeNull();
    expect(exposureRow(null, NOW, norm)).toBeNull();
    const future = exposureRow({ kind: "seen", sid: "x", at: "2030-01-01T00:00:00Z" }, NOW, norm)!;
    expect(future.at).toBe(NOW.toISOString());
    const old = exposureRow({ kind: "seen", sid: "x", at: "2026-10-01T00:00:00Z" }, NOW, norm)!;
    expect(old.day).toBe("2026-11-03");
    const ok = exposureRow(
      { kind: "select", sid: "x", word: "L’Angleterre", at: "2026-11-02T23:00:00Z" },
      NOW,
      norm,
    )!;
    expect(ok).toMatchObject({ word: "angleterre", day: "2026-11-02" });
  });

  it("nothing to record is nothing", async () => {
    expect(await recordExposures(db, A, [], words)).toEqual({ accepted: 0, duplicates: 0 });
  });
});

describe("notes", () => {
  it("create, edit with history, soft delete — only by their author", async () => {
    const r = await noteFor(
      db,
      A,
      book,
      { first: sid(1, 0), last: sid(1, 1), text: "Le roi ?" },
      NOW,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const later = new Date(NOW.getTime() + 1000);
    expect(await updateNote(db, B.userId, book.hash, r.note.id, "volé", later)).toBeNull();
    expect(await deleteNote(db, B.userId, book.hash, r.note.id, later)).toBe(false);
    const edited = await updateNote(db, A.userId, book.hash, r.note.id, "Le roi.", later);
    expect(edited?.history).toEqual([{ text: "Le roi ?", at: NOW.toISOString() }]);
    expect(
      (await updateNote(db, A.userId, book.hash, r.note.id, "Le roi.", later))?.history.length,
    ).toBe(1);
    expect((await notesInLines(db, A.userId, book.hash, 1, 2)).map((n) => n.text)).toEqual([
      "Le roi.",
    ]);
    expect(await notesInLines(db, B.userId, book.hash, 0, 5)).toEqual([]);
    expect(await notesInLines(db, A.userId, book.hash, 3, 5)).toEqual([]);
    expect(await deleteNote(db, A.userId, book.hash, r.note.id, later)).toBe(true);
    expect(await notesInLines(db, A.userId, book.hash, 0, 5)).toEqual([]);
    expect(await updateNote(db, A.userId, book.hash, r.note.id, "x", later)).toBeNull();
  });

  it("refuses empty text, foreign or reversed ranges, another user's read", async () => {
    const g = await gradeFor(
      db,
      B,
      book,
      W,
      { sentences: [sid(2, 0)], rating: 3, granularity: "sentence", clientId: "b-read-01" },
      NOW,
    );
    expect(g.ok).toBe(true);
    const bad = [
      null,
      { first: sid(1, 0), text: "  " },
      { first: sid(1, 0), text: "x".repeat(10_001) },
      { first: "0000000000000000:1.0", text: "x" },
      { first: sid(2, 0), last: sid(1, 0), text: "x" },
      { first: sid(2, 0), text: "x", reviewId: "b-read-01" },
    ];
    for (const b of bad) expect((await noteFor(db, A, book, b as never, NOW)).ok).toBe(false);
    const mine = await noteFor(
      db,
      B,
      book,
      { first: sid(2, 0), text: "ok", reviewId: "b-read-01" },
      NOW,
    );
    expect(mine.ok && mine.note.reviewId).toBe("b-read-01");
  });
});

describe("deleting a book", () => {
  it("deletes its reader rows for that user only, unless they keep another copy", async () => {
    await d1.raw().exec(
      `INSERT INTO read_materials (id, user_id, title, lines, created_at, updated_at) VALUES
       ('mat-a', 'user-a', 't', '[]', 'x', 'x'), ('mat-a2', 'user-a', 't', '[]', 'x', 'x')`,
    );
    await saveContentHash(db, "user-a", "mat-a", book.hash);
    await saveContentHash(db, "user-a", "mat-a2", book.hash);
    for (const ref of [A, B]) {
      await gradeFor(
        db,
        ref,
        book,
        W,
        { sentences: [sid(1, 0)], rating: 3, granularity: "sentence", note: "n" },
        NOW,
      );
      await putProgress(
        db,
        ref.userId,
        ref.materialId,
        { line: 1, offset: 0, at: NOW.toISOString() },
        NOW,
      );
    }
    // A keeps a second copy: only the position of the deleted one goes.
    await deleteReaderRows(db, "user-a", "mat-a", book.hash);
    expect((await getProgress(db, "user-a", "mat-a")).anchor).toBeNull();
    expect((await cardsOfBook(db, "user-a", book.hash)).length).toBe(1);
    await d1.raw().exec("DELETE FROM read_materials WHERE id = 'mat-a'");
    await deleteReaderRows(db, "user-a", "mat-a2", book.hash);
    expect((await cardsOfBook(db, "user-a", book.hash)).length).toBe(0);
    expect(await reviewsInLines(db, "user-a", book.hash, 0, 5)).toEqual([]);
    expect(await notesInLines(db, "user-a", book.hash, 0, 5)).toEqual([]);
    // B untouched.
    expect((await cardsOfBook(db, "user-b", book.hash)).length).toBe(1);
    expect((await getProgress(db, "user-b", "mat-b")).anchor?.line).toBe(1);
    await deleteReaderRows(db, "user-b", "mat-b", null);
    expect((await cardsOfBook(db, "user-b", book.hash)).length).toBe(1);
  });
});
