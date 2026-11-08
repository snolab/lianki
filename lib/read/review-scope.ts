// What follows a passage's grade in the reader (owner, 2026-11-08 ~20:10–20:30
// JST, card ee79dfe4: "这四个复习选项给取消掉…还是四个级别"): the four grade
// levels of a passage's swipe (or the card's handle) no longer mean "review
// its words" ×3 and "its words go Easy" — each opens the word review
// (reader-word-review.tsx) over a wider SCOPE of the book:
//
//   Again (1) → 本段的词            the passage's own words
//   Hard  (2) → 从本章开头到本段的词  the chapter so far, up to and with this passage
//   Good  (3) → 本章全部的词         the whole chapter
//   Easy  (4) → 整本书的词           the whole book
//
// The passage itself is still graded with the level, as before. Pure, so the
// ranges and the word pick are unit-tested (unit/read-review-scope.test.ts).
//
// Fast for a whole book: the lines are cut once by the caller (a book-wide
// index, not the row cache, not the server), the familiarity comes from the
// book's word map, and nothing is asked per paragraph.

import type { Fam, Sentence } from "./reader-model";
import { needsReview, orderWords, spanWords, type ParaWord } from "./word-review";

export type ReviewScope = "para" | "upto" | "chapter" | "book";

/** Narrowest first: the grade levels 1–4 in order. */
export const SCOPES: readonly ReviewScope[] = ["para", "upto", "chapter", "book"];

/** The scope a passage's grade (after the mirror) opens. */
export const scopeOfRating = (r: 1 | 2 | 3 | 4): ReviewScope => SCOPES[r - 1];

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
  if (scope === "book") return [0, nLines];
  const [cs, ce] = chapterSpan(chapterStarts, last, nLines);
  const from = Math.min(first, cs);
  return scope === "upto" ? [from, end] : [from, Math.max(ce, end)];
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
