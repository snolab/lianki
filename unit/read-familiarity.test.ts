import { describe, expect, it } from "bun:test";
import {
  addSum,
  bookPass,
  emptySum,
  gradeScore,
  isUnderstood,
  rangeSum,
  scoreWords,
  sentenceWords,
  toFamiliarity,
} from "@/lib/read/familiarity";
import { segmentBook } from "@/lib/read/units";
import { cardIndex } from "@/lib/read/words";

// Two sentences: "Della compte les sous." (4 words) and "Un deux." (2 words).
const LINES = ["Della compte les sous. Un deux."];
const b = segmentBook(LINES, "fr", "0123456789abcdef");
const sw = sentenceWords(b, LINES);

describe("familiarity aggregates upward, token-weighted", () => {
  it("the running words of each sentence", () => {
    expect(b.n).toBe(2);
    expect(Array.from(sw.ids.subarray(sw.offsets[0], sw.offsets[1]), (i) => sw.dict[i])).toEqual([
      "della",
      "compte",
      "les",
      "sous",
    ]);
  });

  it("names count as known; a mastered card counts in full, a young one by its score", () => {
    const idx = cardIndex([
      { term: "compte", reading: null, lang: "fr", stability: 400, interval: 400, cap: 365 },
      { term: "les", reading: null, lang: "fr", stability: 3, interval: 3, cap: 365 },
    ]);
    const ws = scoreWords(sw, "fr", idx, new Set(["della"]));
    const s0 = toFamiliarity(rangeSum(sw, ws, 0, 0, () => null));
    expect(s0.tokens).toBe(4);
    expect(s0.coverage).toBe(0.5); // della (name) + compte (mastered)
    expect(s0.vocab).toBeGreaterThan(0.5);
    expect(s0.vocab).toBeLessThan(0.75);
    // Never graded: not familiar however well the words are known.
    expect(s0.grade).toBe(0);
    expect(s0.value).toBe(0);
  });

  it("a sentence's grade uses the words' log scale; Good/Easy is understood", () => {
    expect(gradeScore(null)).toBe(0);
    expect(gradeScore({ stability: 365 })).toBe(1);
    expect(gradeScore({ stability: 10 })).toBeGreaterThan(0);
    expect(isUnderstood({ lastRating: 3 })).toBe(true);
    expect(isUnderstood({ lastRating: 2 })).toBe(false);
    expect(isUnderstood(null)).toBe(false);
  });

  it("longer sentences weigh more, and the pass needs both coverage and understanding", () => {
    const all = cardIndex(
      sw.dict.map((w) => ({
        term: w,
        reading: null,
        lang: "fr",
        stability: 400,
        interval: 400,
        cap: 365,
      })),
    );
    const ws = scoreWords(sw, "fr", all, new Set());
    const st = {
      due: "",
      stability: 400,
      reps: 1,
      lapses: 0,
      state: 2 as const,
      lastRating: 3 as const,
      lastAt: "",
    };
    // Only the 4-word sentence understood: 4 of 6 running words.
    const f = toFamiliarity(rangeSum(sw, ws, 0, 1, (i) => (i === 0 ? st : null)));
    expect(f.understood).toBeCloseTo(4 / 6, 3);
    expect(f.graded).toBeCloseTo(4 / 6, 3);
    expect(f.value).toBeCloseTo(4 / 6, 3);
    expect(bookPass(f)).toMatchObject({ words: true, understood: false, passed: false });
    const both = toFamiliarity(rangeSum(sw, ws, 0, 1, () => st));
    expect(bookPass(both).passed).toBe(true);
  });

  it("sums add; an empty unit reads as 0", () => {
    const e = toFamiliarity(emptySum());
    expect(e).toEqual({
      tokens: 0,
      vocab: 0,
      coverage: 0,
      grade: 0,
      understood: 0,
      graded: 0,
      value: 0,
    });
    expect(bookPass(e).passed).toBe(false);
    const s = addSum(emptySum(), { ...emptySum(), tokens: 2, vocab: 1 });
    expect(toFamiliarity(s).vocab).toBe(0.5);
  });
});
