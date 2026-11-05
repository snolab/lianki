// Reader v2 answers, built from the store and the pure libs; the routes only
// add the gate (lib/read/reader-route.ts). Tested against the test D1.

import type { Lemmas } from "./lemma";
import {
  addSum,
  bookPass,
  emptySum,
  rangeSum,
  scoreWords,
  toFamiliarity,
  type WordScores,
} from "./familiarity";
import type { ReaderBook } from "./reader-book";
import { chapterOf } from "./reader-book";
import {
  GRANULARITIES,
  parseSentenceId,
  type DueResponse,
  type FamiliarityResponse,
  type Granularity,
  type GradeRequest,
  type GradeResponse,
  type ItemsResponse,
  type ReadItem,
  type SentenceState,
} from "./reader-api";
import {
  cardsInLines,
  cardsOfBook,
  createNote,
  dueSentences,
  gradeItem,
  NOTE_MAX_CHARS,
  readSamples,
  reviewExists,
  type BookRef,
  type D1Batch,
  type GradeTarget,
} from "./reader-store";
import { matchCards, stateOf, type SentenceCardRow } from "./sentence-cards";
import {
  buildChapterItems,
  estSeconds,
  itemBounds,
  itemKey,
  refOf,
  sentenceIndex,
  sidOf,
  textKey,
} from "./units";
import type { CardHit, WordStats } from "./words";

/** The user's word cards for this book, as the familiarity math needs them. */
export interface WordContext {
  idx: Map<string, CardHit>;
  stats: Pick<WordStats, "names">;
  lem: Lemmas | null;
}

function wordScores(book: ReaderBook, w: WordContext): WordScores {
  return scoreWords(book.words(), book.lang, w.idx, new Set(w.stats.names), w.lem);
}

function states(book: ReaderBook, rows: SentenceCardRow[]): Map<number, SentenceState> {
  const out = new Map<number, SentenceState>();
  for (const [i, r] of matchCards(book.sentences, book.lines, rows)) {
    const s = stateOf(r);
    if (s) out.set(i, s);
  }
  return out;
}

export function parseGranularity(v: unknown): Granularity | null {
  return typeof v === "string" && (GRANULARITIES as readonly string[]).includes(v)
    ? (v as Granularity)
    : null;
}

/** Items of the chapters overlapping [from, to) (default: the chapter holding `from`). */
export async function itemsFor(
  db: D1Batch,
  ref: BookRef,
  book: ReaderBook,
  w: WordContext,
  q: { granularity: Granularity; from: number; to: number | null; seconds?: number },
): Promise<ItemsResponse> {
  const b = book.sentences;
  const c0 = chapterOf(book, q.from);
  const c1 = q.to === null ? c0 : chapterOf(book, Math.max(q.from, q.to - 1));
  const chapters: number[] = [];
  for (let c = c0; c <= c1; c++) chapters.push(c);
  const lines: [number, number] = [book.chapters[c0][0], book.chapters[c1][1]];

  const bounds = itemBounds(await readSamples(db, ref.userId, book.lang), q.granularity, q.seconds);
  const rows = await cardsInLines(db, ref.userId, book.hash, lines[0], lines[1]);
  const st = states(book, rows);
  const ws = wordScores(book, w);
  const sw = book.words();

  const items: ReadItem[] = [];
  const cards: Record<string, SentenceState> = {};
  for (const c of chapters) {
    for (const span of buildChapterItems(
      b,
      book.paragraphs,
      book.chapters[c],
      c,
      q.granularity,
      bounds,
      book.mixed ? book.langOf : undefined,
    )) {
      let due: string | null = null;
      const sentences = [];
      for (let i = span.first; i <= span.last; i++) {
        sentences.push(refOf(b, i));
        const s = st.get(i);
        if (s) {
          cards[sidOf(b, i)] = s;
          if (!due || s.due < due) due = s.due;
        }
      }
      items.push({
        key: itemKey(b, span),
        sentences,
        chapter: c,
        words: span.words,
        seconds: Math.round(estSeconds(span.words, bounds) * 10) / 10,
        fam: toFamiliarity(rangeSum(sw, ws, span.first, span.last, (i) => st.get(i))),
        due,
      });
    }
  }
  return {
    bookHash: book.hash,
    lang: book.lang,
    granularity: q.granularity,
    chapters,
    lines,
    bounds,
    items,
    cards,
  };
}

/** The most sentences one swipe may grade (a whole chapter unsplit fits). */
export const GRADE_MAX_SENTENCES = 5_000;

export type GradeResult = { ok: true; res: GradeResponse } | { ok: false; error: string };

/** Shown → swiped, when both ends make sense: after it was shown, not in the future. */
export function dwellOf(
  body: { shownAt?: unknown; swipedAt?: unknown } | null | undefined,
  now: Date,
): number | null {
  const t = (v: unknown) => (typeof v === "string" ? Date.parse(v) : NaN);
  const shown = t(body?.shownAt);
  const swiped = Number.isFinite(t(body?.swipedAt)) ? t(body?.swipedAt) : now.getTime();
  return Number.isFinite(shown) && swiped > shown && swiped <= now.getTime() + 60_000
    ? Math.round(swiped - shown)
    : null;
}

/** Grade an item: validate its sentences against the book, FSRS each, log the read. */
export async function gradeFor(
  db: D1Batch,
  ref: BookRef,
  book: ReaderBook,
  w: WordContext,
  body: Partial<GradeRequest> | null,
  now: Date,
  fuzz = true,
): Promise<GradeResult> {
  if (!body || typeof body !== "object") return { ok: false, error: "body must be an object" };
  const rating = body.rating;
  if (rating !== 1 && rating !== 2 && rating !== 3 && rating !== 4)
    return { ok: false, error: "rating must be 1–4" };
  const granularity = parseGranularity(body.granularity);
  if (!granularity) return { ok: false, error: "bad granularity" };
  if (!Array.isArray(body.sentences) || !body.sentences.length)
    return { ok: false, error: "sentences are required" };
  if (body.sentences.length > GRADE_MAX_SENTENCES)
    return { ok: false, error: "too many sentences" };
  const b = book.sentences;
  const targets: GradeTarget[] = [];
  const idxs: number[] = [];
  const seen = new Set<string>();
  for (const sid of body.sentences) {
    const p = parseSentenceId(sid);
    if (!p || p.bookHash !== book.hash) return { ok: false, error: "sentence not in this book" };
    const i = sentenceIndex(b, p.line, p.index);
    if (i < 0) return { ok: false, error: "sentence not in this book" };
    if (seen.has(sid)) continue;
    seen.add(sid);
    const [l, , a, z] = refOf(b, i);
    targets.push({ sid, line: p.line, idx: p.index, textKey: textKey(book.lines[l].slice(a, z)) });
    idxs.push(i);
  }
  const words = idxs.reduce((n, i) => n + b.load[i], 0);
  const dwellMs = dwellOf(body, now);
  const clientId =
    typeof body.clientId === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(body.clientId)
      ? body.clientId
      : crypto.randomUUID();
  const note = typeof body.note === "string" ? body.note.trim().slice(0, NOTE_MAX_CHARS) : "";

  const g = await gradeItem(db, ref, {
    targets,
    rating,
    granularity,
    words,
    dwellMs,
    reviewId: clientId,
    now,
    note: note || undefined,
    fuzz,
  });
  const st = states(book, g.rows);
  const cards: Record<string, SentenceState> = {};
  for (const i of idxs) {
    const s = st.get(i);
    if (s) cards[sidOf(b, i)] = s;
  }
  const ws = wordScores(book, w);
  const sum = emptySum();
  for (const i of idxs)
    addSum(
      sum,
      rangeSum(book.words(), ws, i, i, (k) => st.get(k)),
    );
  return {
    ok: true,
    res: {
      reviewId: clientId,
      duplicate: g.duplicate,
      cards,
      fam: toFamiliarity(sum),
      note: g.note,
    },
  };
}

/** Familiarity of every chapter and the book, and the reader-v2 pass. */
export async function familiarityFor(
  db: D1Batch,
  ref: BookRef,
  book: ReaderBook,
  w: WordContext,
): Promise<FamiliarityResponse> {
  const st = states(book, await cardsOfBook(db, ref.userId, book.hash));
  const ws = wordScores(book, w);
  const sw = book.words();
  const b = book.sentences;
  const total = emptySum();
  const chapters = book.chapters.map(([a, z]) => {
    const first = b.lineStart[a];
    const last = b.lineStart[z] - 1;
    const sum = last >= first ? rangeSum(sw, ws, first, last, (i) => st.get(i)) : emptySum();
    addSum(total, sum);
    return toFamiliarity(sum);
  });
  const book_ = toFamiliarity(total);
  return { bookHash: book.hash, book: book_, chapters, pass: bookPass(book_) };
}

export async function dueFor(
  db: D1Batch,
  ref: BookRef,
  book: ReaderBook,
  now: Date,
): Promise<DueResponse> {
  const { rows, next } = await dueSentences(db, ref.userId, book.hash, now);
  return {
    now: now.toISOString(),
    due: rows.map((r) => ({ sid: r.sid, line: r.line, index: r.idx, due: r.due })),
    next,
  };
}

/** A note's range checked against the book. */
export async function noteFor(
  db: D1Batch,
  ref: BookRef,
  book: ReaderBook,
  body: { first?: unknown; last?: unknown; text?: unknown; reviewId?: unknown } | null,
  now: Date,
) {
  if (!body || typeof body !== "object")
    return { ok: false as const, error: "body must be an object" };
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return { ok: false as const, error: "text is required" };
  if (text.length > NOTE_MAX_CHARS) return { ok: false as const, error: "note too long" };
  const f = parseSentenceId(body.first);
  const l = parseSentenceId(body.last ?? body.first);
  const b = book.sentences;
  if (
    !f ||
    !l ||
    f.bookHash !== book.hash ||
    l.bookHash !== book.hash ||
    sentenceIndex(b, f.line, f.index) < 0 ||
    sentenceIndex(b, l.line, l.index) < sentenceIndex(b, f.line, f.index)
  )
    return { ok: false as const, error: "sentence not in this book" };
  let reviewId: string | null = null;
  if (typeof body.reviewId === "string") {
    if (!(await reviewExists(db, ref.userId, body.reviewId)))
      return { ok: false as const, error: "unknown review" };
    reviewId = body.reviewId;
  }
  const note = await createNote(
    db,
    ref,
    {
      first: body.first as string,
      last: (body.last ?? body.first) as string,
      lineFrom: f.line,
      lineTo: l.line,
      text,
      reviewId,
    },
    now,
  );
  return { ok: true as const, note };
}
