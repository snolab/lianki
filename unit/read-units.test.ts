import { describe, expect, it } from "bun:test";
import { parseSentenceId, sentenceId, type ItemBounds } from "@/lib/read/reader-api";
import {
  bookHash,
  buildChapterItems,
  CHUNK_SECONDS,
  chapterRanges,
  itemBounds,
  itemKey,
  MIN_SAMPLES,
  paragraphsOf,
  PRIOR_WORDS_PER_SECOND,
  REACTION_SECONDS,
  readingLoad,
  segmentBook,
  segmentLine,
  sentenceIndex,
  sidOf,
  textKey,
  type ItemSpan,
} from "@/lib/read/units";

const texts = (line: string, lang: string) =>
  segmentLine(line, lang).map(([a, z]) => line.slice(a, z));

describe("sentence ids", () => {
  it("the book hash is 16 hex digits, the same for the same lines, different otherwise", async () => {
    const a = await bookHash(["Un.", "Deux."]);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(await bookHash(["Un.", "Deux."])).toBe(a);
    expect(await bookHash(["Un.", "Deux!"])).not.toBe(a);
    // Line boundaries are part of the text.
    expect(await bookHash(["Un. Deux."])).not.toBe(a);
  });

  it("ids are <hash>:<line>.<index>, round-trip, and reject junk", () => {
    const sid = sentenceId("0123456789abcdef", 12, 3);
    expect(sid).toBe("0123456789abcdef:12.3");
    expect(parseSentenceId(sid)).toEqual({ bookHash: "0123456789abcdef", line: 12, index: 3 });
    for (const bad of ["", "x:1.2", "0123456789abcdef:1", "0123456789ABCDEF:1.2", 5, null])
      expect(parseSentenceId(bad)).toBeNull();
  });

  it("segmenting the same book twice gives the same ids; one line's edit moves no other line's sentences", async () => {
    const lines = ["Il était une fois. Un roi vivait là.", "Fin."];
    const h = await bookHash(lines);
    const a = segmentBook(lines, "fr", h);
    const b = segmentBook(lines, "fr", h);
    expect(Array.from({ length: a.n }, (_, i) => sidOf(a, i))).toEqual(
      Array.from({ length: b.n }, (_, i) => sidOf(b, i)),
    );
    expect(sidOf(a, 0)).toBe(`${h}:0.0`);
    expect(sidOf(a, 2)).toBe(`${h}:1.0`);
    const edited = segmentBook(["Il était une fois. Un roi vivait là.", "La fin, enfin."], "fr", h);
    expect(sidOf(edited, 0)).toBe(sidOf(a, 0));
    expect(sidOf(edited, 1)).toBe(sidOf(a, 1));
    expect(sentenceIndex(a, 1, 0)).toBe(2);
    expect(sentenceIndex(a, 1, 1)).toBe(-1);
    expect(sentenceIndex(a, 9, 0)).toBe(-1);
  });

  it("the text key changes with the text", () => {
    expect(textKey("Il était une fois.")).toMatch(/^[0-9a-f]{8}$/);
    expect(textKey("Il était une fois.")).toBe(textKey("Il était une fois."));
    expect(textKey("Il était une fois.")).not.toBe(textKey("Il était une fois!"));
  });
});

describe("segmentLine: one engine, language data only", () => {
  it("splits at sentence ends, trailing spaces left out", () => {
    expect(texts("Il pleut. Il fait froid !  Viens-tu ?", "fr")).toEqual([
      "Il pleut.",
      "Il fait froid !",
      "Viens-tu ?",
    ]);
  });

  it("does not cut after the language's abbreviations (data file)", () => {
    expect(texts("M. Fogg partit. Il revint.", "fr")).toEqual(["M. Fogg partit.", "Il revint."]);
    expect(texts("Mrs. Aouda smiled. Then she left.", "en")).toEqual([
      "Mrs. Aouda smiled.",
      "Then she left.",
    ]);
  });

  it("CJK sentence ends", () => {
    expect(texts("今日は晴れ。明日は雨です。", "ja")).toEqual(["今日は晴れ。", "明日は雨です。"]);
  });

  it("a piece with no letter or digit joins the sentence before it", () => {
    const s = texts("Il dit. — . Puis rien.", "fr");
    expect(s.every((t) => /\p{L}/u.test(t))).toBe(true);
    expect(s.join(" ")).toContain("Puis rien.");
  });

  it("a line is never empty of sentences", () => {
    expect(segmentLine("***", "en")).toEqual([[0, 3]]);
  });

  it("reading load counts word-like segments, numbers included", () => {
    expect(readingLoad("Il a 3 chats.", "fr")).toBe(4);
  });
});

describe("paragraphs and chapters", () => {
  it("joins lines after a break or a split; plain lines are paragraphs", () => {
    expect(paragraphsOf(5, { breaks: [1, 2], continues: [4] })).toEqual([
      { start: 0, end: 3, breaks: [1, 2] },
      { start: 3, end: 5, breaks: [] },
    ]);
    expect(paragraphsOf(2)).toEqual([
      { start: 0, end: 1, breaks: [] },
      { start: 1, end: 2, breaks: [] },
    ]);
  });

  it("chapter ranges cover the book", () => {
    expect(chapterRanges(10, [0, 4])).toEqual([
      [0, 4],
      [4, 10],
    ]);
    expect(chapterRanges(10, [3])).toEqual([
      [0, 3],
      [3, 10],
    ]);
  });
});

describe("itemBounds: the user's own numbers, a scale-free prior before", () => {
  it("before enough reads: reaction time, the 1–3 minute rule's upper end, prior speed", () => {
    const b = itemBounds([{ words: 10, dwellMs: 1000 }], "paragraph");
    expect(b).toMatchObject({
      minSeconds: REACTION_SECONDS,
      maxSeconds: CHUNK_SECONDS.high,
      wordsPerSecond: PRIOR_WORDS_PER_SECOND,
      speedSource: "prior",
      boundsSource: "prior",
      samples: 1,
    });
  });

  it("from MIN_SAMPLES reads: their median speed, their short and long reads", () => {
    // Reads of 2..20 s at 2 words a second.
    const samples = Array.from({ length: MIN_SAMPLES }, (_, i) => ({
      words: (i + 1) * 4,
      dwellMs: (i + 1) * 2000,
    }));
    const b = itemBounds(samples, "paragraph");
    expect(b.speedSource).toBe("user");
    expect(b.wordsPerSecond).toBeCloseTo(2);
    expect(b.minSeconds).toBeCloseTo(3.8);
    // His long reads (18.2 s here) never make items shorter than the rule's lower end.
    expect(b.maxSeconds).toBe(CHUNK_SECONDS.low);
    // His long reads never make an item past the rule's upper end.
    const long = Array.from({ length: MIN_SAMPLES }, (_, i) => ({
      words: (i + 1) * 400,
      dwellMs: (i + 1) * 200_000,
    }));
    expect(itemBounds(long, "paragraph").maxSeconds).toBe(CHUNK_SECONDS.high);
    // Quick swipes over sentence-sized items do not ratchet a paragraph into sentences.
    const quick = Array.from({ length: 50 }, () => ({ words: 12, dwellMs: 2500 }));
    expect(itemBounds(quick, "paragraph").maxSeconds).toBe(CHUNK_SECONDS.low);
    // Junk reads are ignored.
    expect(
      itemBounds([...samples.slice(1), { words: 0, dwellMs: 5 }], "sentence").boundsSource,
    ).toBe("prior");
  });

  it("by time: the chosen span, else their median read, never under the lower bound", () => {
    expect(itemBounds([], "time").targetSeconds).toBe(REACTION_SECONDS);
    expect(itemBounds([], "time", 30).targetSeconds).toBe(30);
    expect(itemBounds([], "time", 1).targetSeconds).toBe(REACTION_SECONDS);
  });
});

describe("buildChapterItems: bounds in reading time", () => {
  // 1 word a second, so seconds = words.
  const bounds = (min: number, max: number | null, target?: number): ItemBounds => ({
    minSeconds: min,
    maxSeconds: max,
    targetSeconds: target,
    wordsPerSecond: 1,
    speedSource: "user",
    boundsSource: "user",
    samples: 99,
  });
  const lines = [
    "Oui.", // 1 word
    "Non.", // 1
    "Peut-être bien que oui.", // 4-5
    "Un deux trois quatre. Cinq six sept huit. Neuf dix onze douze. Treize quatorze quinze seize.", // 16, 4 sentences
    "Fin du chapitre.", // 3
  ];
  const b = segmentBook(lines, "fr", "0123456789abcdef");
  const paras = paragraphsOf(lines.length);
  const all = (items: ItemSpan[]) =>
    items.flatMap((s) => Array.from({ length: s.last - s.first + 1 }, (_, k) => s.first + k));

  const check = (items: ItemSpan[], a: number, z: number) => {
    // Every sentence exactly once, in order.
    expect(all(items)).toEqual(
      Array.from({ length: b.lineStart[z] - b.lineStart[a] }, (_, k) => b.lineStart[a] + k),
    );
  };

  it("paragraphs: short neighbours merged up to the lower bound; long ones kept whole without an upper bound", () => {
    const items = buildChapterItems(b, paras, [0, 5], 0, "paragraph", bounds(3, null));
    check(items, 0, 5);
    // "Oui." + "Non." + the next paragraph reach 3 s; the long paragraph is one item.
    expect(items[0].words).toBeGreaterThanOrEqual(3);
    expect(items.some((s) => s.first === b.lineStart[3] && s.last === b.lineStart[4] - 1)).toBe(
      true,
    );
  });

  it("paragraphs: a paragraph longer than the upper bound is split at sentence ends", () => {
    const items = buildChapterItems(b, paras, [3, 4], 0, "paragraph", bounds(1, 8));
    check(items, 3, 4);
    expect(items.length).toBe(2);
    for (const s of items) expect(s.words).toBeLessThanOrEqual(8);
  });

  it("sentences: short sentences merge until the lower bound; the last short one joins the one before", () => {
    const items = buildChapterItems(b, paras, [0, 5], 0, "sentence", bounds(4, 100));
    check(items, 0, 5);
    for (const s of items.slice(0, -1)) expect(s.words).toBeGreaterThanOrEqual(4);
  });

  it("by time: sentences packed to the span across paragraphs", () => {
    const items = buildChapterItems(b, paras, [0, 5], 0, "time", bounds(1, null, 10));
    check(items, 0, 5);
    for (const s of items.slice(0, -1)) expect(s.words).toBeGreaterThanOrEqual(10);
  });

  it("the merge never passes the upper bound", () => {
    const items = buildChapterItems(b, paras, [0, 5], 0, "paragraph", bounds(50, 6));
    check(items, 0, 5);
    for (const s of items) if (s.last > s.first) expect(s.words).toBeLessThanOrEqual(6);
  });

  it("items are per chapter: two chapters never share an item, and keys are stable", () => {
    const one = buildChapterItems(b, paras, [0, 3], 0, "paragraph", bounds(100, null));
    const two = buildChapterItems(b, paras, [3, 5], 1, "paragraph", bounds(100, null));
    expect(one.length).toBe(1);
    expect(two.length).toBe(1);
    expect(one[0].last).toBe(b.lineStart[3] - 1);
    expect(itemKey(b, one[0])).toBe("0123456789abcdef:0.0+3");
    expect(buildChapterItems(b, paras, [0, 3], 0, "paragraph", bounds(100, null))).toEqual(one);
  });
});

describe("a book that mixes languages", () => {
  const bounds: ItemBounds = {
    minSeconds: 1000,
    maxSeconds: 5000,
    wordsPerSecond: 1,
    speedSource: "user",
    boundsSource: "user",
    samples: 99,
  };
  it("cuts each line in its own language, and never merges two languages into one item", () => {
    const lines = [
      "Tom met Ana at the market.",
      "トムは市場に行きました。",
      "Then they went home.",
    ];
    const langs = ["en", "ja", "en"];
    const b = segmentBook(lines, "en", "h", (l) => langs[l]);
    const paras = paragraphsOf(lines.length);
    const mixed = buildChapterItems(b, paras, [0, 3], 0, "paragraph", bounds, (l) => langs[l]);
    expect(mixed.map((s) => [s.first, s.last])).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
    // Without languages the short paragraphs merge as before.
    expect(buildChapterItems(b, paras, [0, 3], 0, "paragraph", bounds)).toHaveLength(1);
  });
});
