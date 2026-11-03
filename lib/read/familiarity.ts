// Familiarity, aggregated upward (docs/books-plan.md, "Review units"):
// sentence (its FSRS state + its words) → item / paragraph → chapter → book.
// Every level is a token-weighted mean of its sentences: a sentence weighs its
// running words (lib/read/words.ts), so a long paragraph counts for more than
// a one-word line. Pure.
//
// Per sentence:
//   vocab      = mean word score of its running words (wordScore; names = 1)
//   coverage   = share of its running words mastered or names (the 95% rule)
//   grade      = wordScore(sentence stability), the words' log scale (0 = never graded)
//   understood = 1 when its last grade was Good or Easy
//   value      = min(vocab, grade): known words alone never make it familiar.
//
// Book pass (reader v2) = coverage ≥ BOOK_PASS_COVERAGE (the existing ✓) and
// understood ≥ the same line: the 95% rule applied to sentences too, no new
// threshold.

import { PROGRESS_SCALE_DAYS, wordScore } from "@/lib/words/progress";
import type { Familiarity, SentenceState } from "./reader-api";
import type { BookSentences } from "./units";
import { BOOK_PASS_COVERAGE, hitOf, wordsOf, type CardHit } from "./words";
import type { Lemmas } from "./lemma";

/** The running words of each sentence, as ids into `dict`. */
export interface SentenceWords {
  dict: string[];
  /** Per sentence: ids[offsets[i] .. offsets[i + 1]). */
  offsets: Int32Array;
  ids: Int32Array;
}

export function sentenceWords(b: BookSentences, lines: readonly string[]): SentenceWords {
  const dict: string[] = [];
  const at = new Map<string, number>();
  const offsets = new Int32Array(b.n + 1);
  const ids: number[] = [];
  for (let i = 0; i < b.n; i++) {
    offsets[i] = ids.length;
    const line = lines[b.refs[i * 4]];
    for (const w of wordsOf(line.slice(b.refs[i * 4 + 2], b.refs[i * 4 + 3]), b.lang)) {
      let id = at.get(w);
      if (id === undefined) {
        id = dict.length;
        dict.push(w);
        at.set(w, id);
      }
      ids.push(id);
    }
  }
  offsets[b.n] = ids.length;
  return { dict, offsets, ids: Int32Array.from(ids) };
}

/** Each distinct word's score and whether it counts as known (mastered or a name). */
export interface WordScores {
  score: Float32Array;
  known: Uint8Array;
}

export function scoreWords(
  sw: SentenceWords,
  lang: string,
  idx: Map<string, CardHit>,
  names: ReadonlySet<string>,
  lem?: Lemmas | null,
): WordScores {
  const score = new Float32Array(sw.dict.length);
  const known = new Uint8Array(sw.dict.length);
  sw.dict.forEach((w, i) => {
    const h = idx.size ? hitOf(w, lang, idx, lem) : null;
    if (names.has(w) && !h?.mastered) {
      score[i] = 1;
      known[i] = 1;
    } else if (h) {
      score[i] = h.score;
      known[i] = h.mastered ? 1 : 0;
    }
  });
  return { score, known };
}

/** A sentence's grade score: its FSRS stability on the words' log scale. */
export function gradeScore(s: Pick<SentenceState, "stability"> | null | undefined): number {
  return s ? wordScore({ stability: s.stability }, PROGRESS_SCALE_DAYS) : 0;
}

/** Last grade Good or Easy. */
export function isUnderstood(s: Pick<SentenceState, "lastRating"> | null | undefined): boolean {
  return !!s && s.lastRating >= 3;
}

/** Running sums for a token-weighted mean. */
export interface FamSum {
  tokens: number;
  vocab: number;
  coverage: number;
  grade: number;
  understood: number;
  graded: number;
  value: number;
}

export const emptySum = (): FamSum => ({
  tokens: 0,
  vocab: 0,
  coverage: 0,
  grade: 0,
  understood: 0,
  graded: 0,
  value: 0,
});

/** One sentence's contribution (each share × its tokens). */
export function sentenceSum(
  sw: SentenceWords,
  ws: WordScores,
  i: number,
  state: SentenceState | null | undefined,
): FamSum {
  const a = sw.offsets[i];
  const z = sw.offsets[i + 1];
  const tokens = z - a;
  let vocab = 0;
  let known = 0;
  for (let k = a; k < z; k++) {
    vocab += ws.score[sw.ids[k]];
    known += ws.known[sw.ids[k]];
  }
  const g = gradeScore(state);
  const v = tokens ? vocab / tokens : 1;
  return {
    tokens,
    vocab,
    coverage: known,
    grade: g * tokens,
    understood: isUnderstood(state) ? tokens : 0,
    graded: state ? tokens : 0,
    value: Math.min(v, g) * tokens,
  };
}

export function addSum(into: FamSum, s: FamSum): FamSum {
  into.tokens += s.tokens;
  into.vocab += s.vocab;
  into.coverage += s.coverage;
  into.grade += s.grade;
  into.understood += s.understood;
  into.graded += s.graded;
  into.value += s.value;
  return into;
}

/** The sums as shares. A unit with no running words reads as 0 throughout. */
export function toFamiliarity(s: FamSum): Familiarity {
  const t = s.tokens;
  const r = (x: number) => (t ? Math.round((x / t) * 10_000) / 10_000 : 0);
  return {
    tokens: t,
    vocab: r(s.vocab),
    coverage: r(s.coverage),
    grade: r(s.grade),
    understood: r(s.understood),
    graded: r(s.graded),
    value: r(s.value),
  };
}

/** Sentences [first, last] summed. */
export function rangeSum(
  sw: SentenceWords,
  ws: WordScores,
  first: number,
  last: number,
  stateOf: (i: number) => SentenceState | null | undefined,
): FamSum {
  const sum = emptySum();
  for (let i = first; i <= last; i++) addSum(sum, sentenceSum(sw, ws, i, stateOf(i)));
  return sum;
}

/** The reader-v2 book pass: word coverage and understood both on the 95% line. */
export function bookPass(f: Familiarity, line = BOOK_PASS_COVERAGE) {
  const words = f.tokens > 0 && f.coverage >= line;
  const understood = f.tokens > 0 && f.understood >= line;
  return { line, words, understood, passed: words && understood };
}
