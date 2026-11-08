// What follows a passage's grade in the reader. The four grade levels of a
// passage's swipe (or the card's handle) grade the passage and then:
//
//   Again (1) → review 本段的词           the passage's own words
//   Hard  (2) → review 从本章开头到本段的词 the chapter so far, up to and with this passage
//   Good  (3) → nothing                   the passage's grade only
//   Easy  (4) → its words go Easy          the passage's due and new words graded Easy
//                                          (the grade's easyWords batch, Undo inside the hold)
//
// History: 2026-11-05 Again/Hard/Good opened the passage's review and Easy
// graded its words Easy; 2026-11-08 (card ee79dfe4, #703) the four levels
// widened the review to the paragraph / chapter so far / chapter / book;
// 2026-11-08 later (card d2cf3080) the owner kept the first two, left Good
// empty "for now" and put Easy back as before. Pure, so the ranges and the
// word pick are unit-tested (unit/read-review-scope.test.ts).
//
// Fast for a long chapter: the lines are cut once by the caller (a book-wide
// index, not the row cache, not the server), the familiarity comes from the
// book's word map, and nothing is asked per paragraph.

import type { Fam, Sentence } from "./reader-model";
import { needsReview, orderWords, spanWords, type ParaWord } from "./word-review";

/** The word reviews a passage's grade can open. */
export type ReviewScope = "para" | "upto";

/** What follows a passage's grade: a review's scope, nothing, or its words graded Easy. */
export type AfterGrade = ReviewScope | "none" | "easy";

const AFTER: readonly AfterGrade[] = ["para", "upto", "none", "easy"];

/** What follows a passage's grade (the grade given, after the mirror). */
export const afterGrade = (r: 1 | 2 | 3 | 4): AfterGrade => AFTER[r - 1];

/**
 * What a passage's grade does once its scope's words are known (owner,
 * 2026-11-08 22:01 JST): a review opens only when the scope has at least one
 * word due or new; with none it stays in the text and says so ("empty").
 * `due`: how many of the scope's words are due or new; null: not known (no
 * server plan, signed out), the review opens on any word as before.
 */
export function afterScope(
  after: AfterGrade,
  words: number,
  due: number | null,
): "review" | "empty" | "none" | "easy" {
  if (after === "none" || after === "easy") return after;
  if (!words) return "empty";
  return due === null || due > 0 ? "review" : "empty";
}

/**
 * The name each level of a passage's grade handle shows (owner, 2026-11-08
 * 21:43 JST: the levels read as what they do, not Again/Hard/Good/Easy):
 * the i18n key of read-grade-handle, or null for the level that only grades.
 */
export const LEVEL_KEY = {
  para: "levelPara",
  upto: "levelUpTo",
  none: null,
  easy: "levelEasy",
} as const satisfies Record<AfterGrade, string | null>;

/** What the review endpoints take in one call (lib/read/reader-route.ts rangeWords). */
export const MAX_SCOPE_WORDS = 400;

/** The chapter holding `line`: its lines [start, end). No chapters: the whole book. */
export function chapterSpan(
  starts: readonly number[],
  line: number,
  nLines: number,
): [number, number] {
  let lo = 0;
  let hi = starts.length - 1;
  let at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= line) {
      at = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  // Before the first chapter (a title page): that front matter is its own span.
  if (at < 0) return [0, starts.length ? Math.min(starts[0], nLines) : nLines];
  return [starts[at], Math.min(starts[at + 1] ?? nLines, nLines)];
}

/**
 * The lines [from, to) a scope covers, for a passage on lines first..last.
 * The chapter is the one the passage ends in; a passage that starts in the
 * chapter before still counts whole.
 */
export function scopeLines(
  scope: ReviewScope,
  first: number,
  last: number,
  chapterStarts: readonly number[],
  nLines: number,
): [number, number] {
  const end = Math.min(last + 1, nLines);
  if (scope === "para") return [first, end];
  const [cs] = chapterSpan(chapterStarts, last, nLines);
  return [Math.min(first, cs), end];
}

/**
 * A scope's words for the review: the distinct counted words of its lines in
 * reading order (each with the first sentence it occurs in, its example),
 * without the ones he knows (the word map's "k"), the unknown and weakest
 * first (orderWords), at most `cap`. `sentencesOf(line)`: a line's sentences,
 * or null for a blank line or a heading.
 */
export function scopeWords(
  from: number,
  to: number,
  sentencesOf: (line: number) => readonly Sentence[] | null,
  fam: Map<string, Fam> | null,
  cap = MAX_SCOPE_WORDS,
): { sentences: Sentence[]; words: ParaWord[] } {
  const parts = [];
  for (let l = from; l < to; l++) {
    const ss = sentencesOf(l);
    if (ss?.length) parts.push({ ss, from: null, to: null });
  }
  const { sentences, words } = spanWords(parts, fam);
  const { first } = orderWords(words.filter((w) => needsReview(w.fam)));
  return { sentences, words: first.slice(0, cap) };
}
