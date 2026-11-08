/**
 * The four review scopes a passage's grade opens in the reader
 * (lib/read/review-scope.ts; owner, 2026-11-08): this paragraph, the chapter
 * up to it, the whole chapter, the whole book — their lines, their words, and
 * their place in the URL (lib/read/review-ref.ts).
 */
import { describe, expect, test } from "bun:test";
import type { Fam, Sentence } from "@/lib/read/reader-model";
import {
  MAX_SCOPE_WORDS,
  SCOPES,
  chapterSpan,
  scopeLines,
  scopeOfRating,
  scopeWords,
} from "@/lib/read/review-scope";
import { decodeReviewRef, reviewOfHref, scopeRef } from "@/lib/read/review-ref";

const sentence = (words: string[]): Sentence => ({
  text: words.join(" "),
  segs: words.flatMap((w, i) => [
    ...(i ? [{ text: " ", t: -1, w: null }] : []),
    { text: w, t: i, w: w.toLowerCase() },
  ]),
});

describe("scopeOfRating", () => {
  test("Again, Hard, Good, Easy widen from the paragraph to the book", () => {
    expect(([1, 2, 3, 4] as const).map(scopeOfRating)).toEqual(["para", "upto", "chapter", "book"]);
    expect(SCOPES).toHaveLength(4);
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
    expect(scopeLines("chapter", 14, 14, starts, 30)).toEqual([10, 20]);
    expect(scopeLines("book", 14, 14, starts, 30)).toEqual([0, 30]);
  });
  test("a passage over several lines counts whole", () => {
    expect(scopeLines("para", 12, 13, starts, 30)).toEqual([12, 14]);
    expect(scopeLines("upto", 12, 13, starts, 30)).toEqual([10, 14]);
  });
  test("a passage starting in the chapter before keeps its first line", () => {
    expect(scopeLines("upto", 9, 10, starts, 30)).toEqual([9, 11]);
    expect(scopeLines("chapter", 9, 10, starts, 30)).toEqual([9, 20]);
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
  test("a whole book is fast: 5 000 lines of 20 words in well under a second", () => {
    const line = (l: number) => [
      sentence(Array.from({ length: 20 }, (_, i) => `w${(l * 7 + i) % 3000}`)),
    ];
    const t = performance.now();
    const { words } = scopeWords(0, 5000, line, null);
    expect(words).toHaveLength(MAX_SCOPE_WORDS);
    expect(performance.now() - t).toBeLessThan(1000);
  });
});

describe("the wider scopes in the URL", () => {
  test("round-trip", () => {
    expect(scopeRef("upto", 14)).toBe("u14");
    expect(scopeRef("chapter", 14)).toBe("c14");
    expect(scopeRef("book", 14)).toBe("b");
    expect(decodeReviewRef("u14")).toEqual({ kind: "upto", line: 14 });
    expect(decodeReviewRef("c0")).toEqual({ kind: "chapter", line: 0 });
    expect(decodeReviewRef("b")).toEqual({ kind: "book" });
    expect(reviewOfHref("/read/x?review=c3")).toBe("c3");
  });
  test("refuse anything else", () => {
    for (const bad of ["u", "c-1", "u01", "b0", "bb", "x3", "c1.2"])
      expect(decodeReviewRef(bad)).toBeNull();
  });
});
