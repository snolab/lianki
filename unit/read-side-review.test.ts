import { describe, expect, it } from "bun:test";
import { cutPara, type Fam } from "@/lib/read/reader-model";
import { dueBookWords, findWord, sideKindOf } from "@/lib/read/side-review";
import { WORD_STATS_V, type WordStats } from "@/lib/read/words";
import { sideReviewOn } from "@/lib/read/reader-book";

describe("sideReviewOn", () => {
  it("is on with the flag for everyone, and for the owner without it", () => {
    expect(sideReviewOn({}, false)).toBe(false);
    expect(sideReviewOn({ "read.side-review": true }, false)).toBe(true);
    expect(sideReviewOn(null, true)).toBe(true);
  });
});

const stats = (words: string[]): WordStats =>
  ({
    v: WORD_STATS_V,
    lang: "en",
    tokens: words.length,
    distinct: words.length,
    words: words.map((w) => [w, 1]),
    names: [],
  }) as WordStats;

describe("dueBookWords", () => {
  it("takes the book words whose card is due now, not later or without a date", () => {
    const now = Date.parse("2026-11-04T07:00:00Z");
    const rows = [
      { term: "cat", reading: null, lang: "en", due: "2026-11-04T06:00:00.000Z" },
      { term: "dog", reading: null, lang: "en-US", due: "2026-11-05T06:00:00.000Z" },
      { term: "bird", reading: null, lang: "en", due: null },
    ];
    expect(dueBookWords(stats(["cat", "dog", "bird", "fish"]), rows, now)).toEqual(["cat"]);
  });
});

describe("findWord", () => {
  const lines = ["The cat sat.", "", "A dog and a cat ran."];
  const ss = (l: number) => (lines[l]?.trim() ? cutPara(lines[l], "en").sentences : null);
  const fam = new Map<string, Fam>([
    ["cat", "l1"],
    ["dog", "n"],
  ]);
  const kindOf = (w: string) => sideKindOf(w, fam, new Set(["cat"]), new Set());

  it("finds the next due and new words across paragraphs, skipping blanks", () => {
    const a = findWord({ line: 0, t: -1 }, 1, "due", lines.length, ss, kindOf);
    expect(a && [a.line, a.w, a.kind]).toEqual([0, "cat", "due"]);
    const b = findWord({ line: a!.line, t: a!.t }, 1, null, lines.length, ss, kindOf);
    expect(b && [b.line, b.w, b.kind]).toEqual([2, "dog", "new"]);
    const c = findWord({ line: b!.line, t: b!.t }, 1, "due", lines.length, ss, kindOf);
    expect(c && [c.line, c.w]).toEqual([2, "cat"]);
    expect(findWord({ line: c!.line, t: c!.t }, 1, null, lines.length, ss, kindOf)).toBeNull();
  });

  it("goes back too, and leaves out words graded here", () => {
    const back = findWord({ line: 2, t: 99 }, -1, "due", lines.length, ss, kindOf);
    expect(back && [back.line, back.w]).toEqual([2, "cat"]);
    const done = (w: string) => sideKindOf(w, fam, new Set(["cat"]), new Set(["cat"]));
    expect(findWord({ line: 0, t: -1 }, 1, "due", lines.length, ss, done)).toBeNull();
  });
});
