/**
 * What a passage's grade does in the reader (lib/read/review-scope.ts; owner,
 * 2026-11-08, card d2cf3080): Again reviews this paragraph's words, Hard the
 * chapter's up to it, Good nothing, Easy grades its words Easy — the two
 * reviews' lines, their words, and the chapter one's place in the URL
 * (lib/read/review-ref.ts).
 */
import { describe, expect, test } from "bun:test";
import type { Fam, Sentence } from "@/lib/read/reader-model";
import {
  MAX_SCOPE_WORDS,
  afterGrade,
  afterScope,
  LEVEL_KEY,
  chapterSpan,
  scopeLines,
  scopeWords,
} from "@/lib/read/review-scope";
import { decodeReviewRef, reviewOfHref, uptoRef } from "@/lib/read/review-ref";

const sentence = (words: string[]): Sentence => ({
  text: words.join(" "),
  segs: words.flatMap((w, i) => [
    ...(i ? [{ text: " ", t: -1, w: null }] : []),
    { text: w, t: i, w: w.toLowerCase() },
  ]),
});

describe("afterGrade", () => {
  test("Again the paragraph, Hard the chapter so far, Good nothing, Easy its words Easy", () => {
    expect(([1, 2, 3, 4] as const).map(afterGrade)).toEqual(["para", "upto", "none", "easy"]);
  });
});

describe("chapterSpan", () => {
  const starts = [2, 10, 20];
  test("the chapter holding a line, the last one to the end", () => {
    expect(chapterSpan(starts, 2, 30)).toEqual([2, 10]);
    expect(chapterSpan(starts, 9, 30)).toEqual([2, 10]);
    expect(chapterSpan(starts, 10, 30)).toEqual([10, 20]);
    expect(chapterSpan(starts, 29, 30)).toEqual([20, 30]);
  });
  test("front matter before the first chapter is its own span", () => {
    expect(chapterSpan(starts, 0, 30)).toEqual([0, 2]);
  });
  test("no chapters: the whole book", () => {
    expect(chapterSpan([], 7, 30)).toEqual([0, 30]);
  });
});

describe("scopeLines", () => {
  const starts = [0, 10, 20];
  test("each scope's lines for a passage on line 14", () => {
    expect(scopeLines("para", 14, 14, starts, 30)).toEqual([14, 15]);
    expect(scopeLines("upto", 14, 14, starts, 30)).toEqual([10, 15]);
  });
  test("a passage over several lines counts whole", () => {
    expect(scopeLines("para", 12, 13, starts, 30)).toEqual([12, 14]);
    expect(scopeLines("upto", 12, 13, starts, 30)).toEqual([10, 14]);
  });
  test("a passage starting in the chapter before keeps its first line", () => {
    expect(scopeLines("upto", 9, 10, starts, 30)).toEqual([9, 11]);
  });
  test("the first paragraph of a chapter: up to here is that paragraph", () => {
    expect(scopeLines("upto", 10, 10, starts, 30)).toEqual([10, 11]);
  });
});

describe("scopeWords", () => {
  // Lines: 0 heading (null), 1 "The cat sat", 2 blank, 3 "The dog ran far", 4 "A cat ran".
  const book: (Sentence[] | null)[] = [
    null,
    [sentence(["The", "cat", "sat"])],
    null,
    [sentence(["The", "dog"]), sentence(["ran", "far"])],
    [sentence(["A", "cat", "ran"])],
  ];
  const of = (l: number) => book[l] ?? null;
  const fam = new Map<string, Fam>([
    ["the", "k"],
    ["a", "k"],
    ["cat", "l2"],
    ["sat", "n"],
    ["dog", "u"],
    ["ran", "l1"],
  ]);

  test("distinct, the known ones left out, the unknown and weakest first", () => {
    const { words } = scopeWords(0, 5, of, fam);
    expect(words.map((w) => w.w)).toEqual(["dog", "sat", "far", "ran", "cat"]);
  });
  test("each word's example is the first sentence it occurs in, in the scope", () => {
    const { sentences, words } = scopeWords(3, 5, of, fam);
    const ex = Object.fromEntries(words.map((w) => [w.w, sentences[w.s].text]));
    expect(ex).toEqual({ dog: "The dog", ran: "ran far", far: "ran far", cat: "A cat ran" });
  });
  test("only the scope's own lines", () => {
    expect(scopeWords(1, 2, of, fam).words.map((w) => w.w)).toEqual(["sat", "cat"]);
    expect(scopeWords(0, 1, of, fam).words).toEqual([]);
  });
  test("no word map: every word counts as new", () => {
    expect(scopeWords(1, 2, of, null).words.map((w) => w.w)).toEqual(["the", "cat", "sat"]);
  });
  test("at most what the endpoints take, the weakest kept", () => {
    const many = [sentence(Array.from({ length: 900 }, (_, i) => `w${i}`))];
    const f = new Map<string, Fam>([["w899", "u"]]);
    const { words } = scopeWords(0, 1, () => many, f);
    expect(words).toHaveLength(MAX_SCOPE_WORDS);
    expect(words[0].w).toBe("w899");
  });
  test("a book with no chapters is fast up to its end: 5 000 lines of 20 words in well under a second", () => {
    const line = (l: number) => [
      sentence(Array.from({ length: 20 }, (_, i) => `w${(l * 7 + i) % 3000}`)),
    ];
    const t = performance.now();
    const { words } = scopeWords(0, 5000, line, null);
    expect(words).toHaveLength(MAX_SCOPE_WORDS);
    expect(performance.now() - t).toBeLessThan(1000);
  });
});

describe("the chapter-up-to-here review in the URL", () => {
  test("round-trip", () => {
    expect(uptoRef(14)).toBe("u14");
    expect(decodeReviewRef("u14")).toEqual({ kind: "upto", line: 14 });
    expect(decodeReviewRef("u0")).toEqual({ kind: "upto", line: 0 });
    expect(reviewOfHref("/reader/x?review=u3")).toBe("u3");
  });
  test("refuse anything else, the retired chapter and book refs too", () => {
    for (const bad of ["u", "u-1", "u01", "c3", "b", "b0", "x3", "u1.2"])
      expect(decodeReviewRef(bad)).toBeNull();
  });
});

describe("afterScope: a review opens only on a word due or new (owner, 2026-11-08 22:01 JST)", () => {
  test("Again / Hard with a due or new word open the review", () => {
    expect(afterScope("para", 5, 2)).toBe("review");
    expect(afterScope("upto", 40, 1)).toBe("review");
  });
  test("no word due or new: no review, he stays in the text", () => {
    expect(afterScope("para", 5, 0)).toBe("empty");
    expect(afterScope("upto", 40, 0)).toBe("empty");
    expect(afterScope("upto", 0, 0)).toBe("empty");
    expect(afterScope("para", 0, null)).toBe("empty");
  });
  test("no plan known (the device's own reader): any word opens it, as before", () => {
    expect(afterScope("upto", 3, null)).toBe("review");
  });
  test("Good and Easy open nothing", () => {
    expect(afterScope("none", 9, 9)).toBe("none");
    expect(afterScope("easy", 9, 9)).toBe("easy");
  });
});

describe("LEVEL_KEY: a paragraph's handle names its levels by what they do", () => {
  test("本段 / 到本段 / (grade only) / 全标简单", () => {
    expect(([1, 2, 3, 4] as const).map((r) => LEVEL_KEY[afterGrade(r)])).toEqual([
      "levelPara",
      "levelUpTo",
      null,
      "levelEasy",
    ]);
  });
});
