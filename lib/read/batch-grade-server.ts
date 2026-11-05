// The server side of the selection card's grade handle (lib/read/batch-grade.ts
// holds the rules): one validated call grades a batch — the selection's due
// and never-graded sentences (the reader's own FSRS per sentence, as a swipe
// writes them) and its due and new words (/words' own review write,
// WordsD1Repo.review, after 制卡 for words with no card) — and one call takes
// the whole batch back, each card to exactly the state it had before:
// sentences from read_grade_undo, word cards through WordsD1Repo.undo (the
// card before its last review), cards the batch made removed again. A card
// changed since by something else is left alone. Every statement is scoped to
// the signed-in user.

import { WordsD1Repo } from "@/lib/repos/wordsD1";
import { parseCard, reviewWord } from "@/lib/words/schedule";
import type { SwipeRating } from "@/lib/words/swipe";
import { splitSentences, splitWords, type SentenceProbe, type WordProbe } from "./batch-grade";
import {
  makeCards,
  unmakeCards,
  wordTargets,
  type BookCtx,
  type Gloss,
  type RangeWord,
  type WordTarget,
} from "./book-word-list";
import type { ReaderBook } from "./reader-book";
import { gradeFor, GRADE_MAX_SENTENCES, type WordContext } from "./reader-service";
import {
  revertSentences,
  sentenceCards,
  undoRecord,
  undoWordsStatement,
  type BookRef,
  type D1Batch,
} from "./reader-store";
import { gradeSentence, parseSentenceCard } from "./sentence-cards";

const RATINGS: readonly SwipeRating[] = [1, 2, 3, 4];
const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;

export interface BatchCtx {
  db: D1Batch;
  ref: BookRef;
  email: string;
  book: ReaderBook;
  w: WordContext;
  bctx: BookCtx;
}

const asProbe = (t: WordTarget, next?: WordProbe["next"]): WordProbe => {
  const c = parseCard(t.card);
  return {
    w: t.w,
    listId: t.listId,
    term: t.term,
    due: c ? c.due.toISOString() : null,
    reps: t.reps,
    ...(next ? { next } : {}),
  };
};

/** Validated sentence ids of this book, deduplicated (null: one is not the book's). */
function bookSids(raw: unknown, book: ReaderBook): string[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > GRADE_MAX_SENTENCES) return null;
  const prefix = `${book.hash}:`;
  const out = new Set<string>();
  for (const s of raw) {
    if (typeof s !== "string" || !s.startsWith(prefix)) return null;
    out.add(s);
  }
  return [...out];
}

/** Each sentence's due (ISO), or null for never graded. */
async function sentenceDues(c: BatchCtx, sids: string[]): Promise<SentenceProbe> {
  const rows = new Map((await sentenceCards(c.db, c.ref.userId, sids)).map((r) => [r.sid, r]));
  const out: SentenceProbe = {};
  for (const s of sids) out[s] = rows.get(s)?.due ?? null;
  return out;
}

/**
 * The probe: what each sentence and word of the selection is now, and the
 * due each grade would give a word (its list's parameters, no fuzz) and a
 * single sentence. Writes nothing.
 */
export async function probeBatch(
  c: BatchCtx,
  rawSids: unknown,
  words: RangeWord[],
  now: Date,
): Promise<
  | {
      ok: true;
      res: {
        sentences: SentenceProbe;
        words: WordProbe[];
        /** A single sentence's due after each grade (ISO, by rating). */
        sentenceNext?: Partial<Record<SwipeRating, string>>;
      };
    }
  | { ok: false; error: string }
> {
  const sids = bookSids(rawSids, c.book);
  if (!sids) return { ok: false, error: "sentence not in this book" };
  const sentences = await sentenceDues(c, sids);
  const targets = words.length ? await wordTargets(c.db, c.email, c.bctx, words) : [];
  const lists = targets.some((t) => t.listId)
    ? new Map((await new WordsD1Repo(c.db, c.email).lists()).map((l) => [l.id, l.params]))
    : new Map();
  const out = targets.map((t) => {
    const params = t.listId ? lists.get(t.listId) : undefined;
    if (!params || !t.card) return asProbe(t);
    const next: WordProbe["next"] = {};
    for (const r of RATINGS)
      next[r] = reviewWord(parseCard(t.card), r, now, params, false).card.due.toISOString();
    return asProbe(t, next);
  });
  let sentenceNext: Partial<Record<SwipeRating, string>> | undefined;
  if (sids.length === 1) {
    const row = (await sentenceCards(c.db, c.ref.userId, sids))[0];
    const card = parseSentenceCard(row?.card);
    sentenceNext = {};
    for (const r of RATINGS) sentenceNext[r] = gradeSentence(card, r, now, false).due.toISOString();
  }
  return { ok: true, res: { sentences, words: out, ...(sentenceNext ? { sentenceNext } : {}) } };
}

/** One word card a batch graded: the card it wrote, and whether the batch made it. */
type UndoWord = { listId: string; term: string; after: string; made: boolean };

export interface BatchResult {
  id: string;
  duplicate: boolean;
  /** Sentences graded, and the not-due ones skipped. */
  sentences: string[];
  skippedSentences: number;
  /** Words graded, with their new due. */
  words: { w: string; listId: string; term: string; due: string; made: boolean }[];
  skippedWords: number;
}

/**
 * Grade a batch: `{ clientId, rating, sentences: [sid], words: [RangeWord], day? }`.
 * Only due or never-graded sentences and due or new words are graded; a
 * word with no card gets one in the book's list first (制卡). A clientId seen
 * before grades nothing again.
 */
export async function gradeBatch(
  c: BatchCtx,
  body: {
    clientId?: unknown;
    rating?: unknown;
    sentences?: unknown;
    day?: string;
    shownAt?: unknown;
    swipedAt?: unknown;
  },
  words: RangeWord[],
  now: Date,
  gloss?: Gloss,
): Promise<{ ok: true; res: BatchResult } | { ok: false; error: string }> {
  const rating = body.rating;
  if (rating !== 1 && rating !== 2 && rating !== 3 && rating !== 4)
    return { ok: false, error: "rating must be 1–4" };
  const id = typeof body.clientId === "string" ? body.clientId : "";
  if (!CLIENT_ID.test(id)) return { ok: false, error: "clientId is required" };
  const sids = bookSids(body.sentences, c.book);
  if (!sids) return { ok: false, error: "sentence not in this book" };
  if (!sids.length && !words.length) return { ok: false, error: "nothing to grade" };
  if (await undoRecord(c.db, c.ref.userId, id))
    return {
      ok: true,
      res: { id, duplicate: true, sentences: [], skippedSentences: 0, words: [], skippedWords: 0 },
    };
  const t = now.getTime();
  const { grade: gs, skipped } = splitSentences(sids, await sentenceDues(c, sids), t);

  const { undoWords, outWords, skippedWords } = await gradeWords(
    c,
    words,
    rating,
    body.day,
    now,
    gloss,
  );
  // Sentences through the reader's own grade (FSRS per sentence, its read and undo record).
  if (gs.length) {
    const r = await gradeFor(
      c.db,
      c.ref,
      c.book,
      c.w,
      {
        sentences: gs,
        rating,
        granularity: "sentence",
        clientId: id,
        ...(typeof body.shownAt === "string" ? { shownAt: body.shownAt } : {}),
        ...(typeof body.swipedAt === "string" ? { swipedAt: body.swipedAt } : {}),
      },
      now,
    );
    if (!r.ok) return r;
  }
  await c.db.batch([
    undoWordsStatement(c.db, c.ref, id, JSON.stringify(undoWords), now.toISOString()),
  ]);
  return {
    ok: true,
    res: {
      id,
      duplicate: false,
      sentences: gs,
      skippedSentences: skipped.length,
      words: outWords,
      skippedWords,
    },
  };
}

/**
 * A batch's words: the due or new ones graded `rating` through /words' own
 * review (WordsD1Repo.review), words with no card carded first in the book's
 * list (制卡). Returns what the undo record keeps. Also the words of an Easy
 * paragraph swipe (app/api/read/[id]/grade, owner 2026-11-05 02:31 JST).
 */
export async function gradeWords(
  c: Pick<BatchCtx, "db" | "email" | "bctx">,
  words: RangeWord[],
  rating: SwipeRating,
  dayIn: string | undefined,
  now: Date,
  gloss?: Gloss,
): Promise<{ undoWords: UndoWord[]; outWords: BatchResult["words"]; skippedWords: number }> {
  const t = now.getTime();
  // Words: due or new cards; words with no card are carded first, in the book's list.
  const before = words.length ? await wordTargets(c.db, c.email, c.bctx, words) : [];
  const split = splitWords(
    before.map((x) => asProbe(x)),
    t,
  );
  const byW = new Map(words.map((x) => [x.w, x]));
  let madeTerms: string[] = [];
  let grade = split.grade;
  if (split.make.length) {
    const made = await makeCards(
      c.db,
      c.email,
      c.bctx,
      split.make.flatMap((p) => byW.get(p.w) ?? []),
      now,
      gloss,
    );
    madeTerms = made.terms;
    const after = await wordTargets(
      c.db,
      c.email,
      c.bctx,
      split.make.flatMap((p) => byW.get(p.w) ?? []),
    );
    // Only the cards this batch made: a race lost to another list made none here.
    const fresh = after
      .map((x) => asProbe(x))
      .filter((p) => p.listId === made.listId && madeTerms.includes(p.term ?? ""));
    grade = [...grade, ...fresh];
  }
  const repo = new WordsD1Repo(c.db, c.email);
  const byList = new Map<string, WordProbe[]>();
  const seen = new Set<string>();
  for (const p of grade) {
    const k = `${p.listId}\u0000${p.term}`;
    if (!p.listId || !p.term || seen.has(k)) continue;
    seen.add(k);
    byList.set(p.listId, [...(byList.get(p.listId) ?? []), p]);
  }
  const undoWords: UndoWord[] = [];
  const outWords: BatchResult["words"] = [];
  const day = dayIn && /^\d{4}-\d{2}-\d{2}$/.test(dayIn) ? dayIn : now.toISOString().slice(0, 10);
  for (const [listId, ps] of byList) {
    const r = await repo.review(
      listId,
      ps.map((p) => ({ term: p.term!, rating, reviewedAt: now.toISOString() })),
      day,
      now,
      null,
    );
    for (const card of r?.cards ?? []) {
      const p = ps.find((x) => x.term === card.term)!;
      const made = p.reps === 0 && madeTerms.includes(card.term);
      undoWords.push({ listId, term: card.term, after: card.card, made });
      outWords.push({ w: p.w, listId, term: card.term, due: card.due, made });
    }
  }
  return { undoWords, outWords, skippedWords: split.skipped.length };
}

/** The words a batch would grade now (due, new, or no card yet), by the book's word: read-only. */
export async function planWords(
  c: Pick<BatchCtx, "db" | "email" | "bctx">,
  words: RangeWord[],
  now: Date,
): Promise<string[]> {
  if (!words.length) return [];
  const split = splitWords(
    (await wordTargets(c.db, c.email, c.bctx, words)).map((x) => asProbe(x)),
    now.getTime(),
  );
  return [...split.grade, ...split.make].map((p) => p.w);
}

/**
 * Take a batch (or a sent paragraph grade) back: `{ undo: clientId }`.
 * Sentences return to their rows before it, words to their card before it
 * (only a card still as the batch left it), cards it made are removed.
 */
export async function undoBatch(
  c: Pick<BatchCtx, "db" | "ref" | "email" | "bctx">,
  id: unknown,
  day: string | undefined,
): Promise<{ restored: number; changed: number } | null> {
  if (typeof id !== "string" || !CLIENT_ID.test(id)) return null;
  const rec = await undoRecord(c.db, c.ref.userId, id);
  if (!rec || rec.materialId !== c.ref.materialId) return null;
  let words: UndoWord[] = [];
  try {
    words = rec.words ? (JSON.parse(rec.words) as UndoWord[]) : [];
  } catch {}
  const repo = new WordsD1Repo(c.db, c.email);
  let restored = 0;
  let changed = 0;
  const unmake: string[] = [];
  const d = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : new Date().toISOString().slice(0, 10);
  for (const x of words) {
    const row = await c.db
      .prepare("SELECT card FROM word_cards WHERE email = ? AND list_id = ? AND term = ?")
      .bind(c.email, x.listId, x.term)
      .first<{ card: string }>();
    // Graded again since (on /words, another tab): that grade stays.
    if (!row || row.card !== x.after) {
      changed++;
      continue;
    }
    if (await repo.undo(x.listId, x.term, d)) restored++;
    if (x.made) unmake.push(x.term);
  }
  if (unmake.length) await unmakeCards(c.db, c.email, c.bctx.hash, unmake);
  const s = await revertSentences(c.db, c.ref, id, rec.sentences);
  return { restored: restored + s.restored, changed: changed + s.changed };
}
