import { describe, expect, it } from "bun:test";
import {
  ParaCache,
  blockLine,
  blockOfAnchor,
  blockOfLine,
  blockSpeech,
  cutPara,
  famMap,
  itemCoverage,
  itemWords,
  learningBand,
  localItems,
  marksByLine,
  nextParaItem,
  sentencesFromCuts,
  pieceSentences,
  railLevel,
  roughWords,
  sentencesOf,
  type WordRow,
} from "@/lib/read/reader-model";
import { CHROME_FULL, chromeStep } from "@/lib/read/reader-chrome";
import { anchorAt, loadAnchor, newestAnchor, parseAnchor, saveAnchor } from "@/lib/read/reader-pos";
import { localReaderData } from "@/lib/read/reader-adapter";

/** A sentence of n words (capitalised: a sentence break needs one). */
const words = (n: number, w = "word") =>
  "W" +
  Array.from({ length: n }, () => w)
    .join(" ")
    .slice(1) +
  ".";

describe("reader model: sentences and tokens", () => {
  it("cuts sentences with the platform segmenter, whitespace kept with the sentence", () => {
    const s = sentencesOf("Il dit bonjour. Elle rit! Puis rien.", "fr");
    expect(s.length).toBe(3);
    expect(s.join("")).toBe("Il dit bonjour. Elle rit! Puis rien.");
  });

  it("numbers word tokens across the paragraph, stable per sentence", () => {
    const p = cutPara("Le chat dort. L'homme regarde.", "fr");
    const toks = p.sentences.flatMap((s) => s.segs.filter((g) => g.t >= 0).map((g) => g.t));
    expect(toks).toEqual([0, 1, 2, 3, 4]);
    // Normalised as the word map (lib/read/words.ts): elision stripped.
    const w = p.sentences[1].segs.filter((g) => g.t >= 0).map((g) => g.w);
    expect(w).toEqual(["homme", "regarde"]);
    // Nothing lost: the text renders back exactly.
    expect(p.sentences.map((s) => s.segs.map((g) => g.text).join("")).join("")).toBe(
      "Le chat dort. L'homme regarde.",
    );
  });

  it("keeps the paragraph cache bounded and recent", () => {
    const c = new ParaCache(["a b.", "c d.", "e f."], "en", "en", 2);
    const first = c.get(0);
    c.get(1);
    expect(c.get(0)).toBe(first);
    c.get(2); // evicts 1, the oldest
    expect(c.get(0)).toBe(first);
  });

  it("counts CJK by character, half a word each", () => {
    expect(roughWords("one two three")).toBe(3);
    expect(roughWords("我们读书")).toBe(2);
  });

  it("sizes an item by reading time, never a fixed count", () => {
    expect(itemWords(120)).toBe(120);
    expect(itemWords(60, 2)).toBe(120);
    expect(itemWords(0)).toBe(1);
  });
});

describe("reader model: items", () => {
  const base = { headings: new Set<number>(), chapterStarts: new Set<number>(), lang: "en" };

  it("merges short paragraphs into one item, up to the target", () => {
    const lines = [words(10), words(10), words(10), words(10)];
    const b = localItems({ ...base, lines, target: 25 });
    expect(b.map((x) => (x.kind === "item" ? x.pieces.map((p) => p.line) : x.line))).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it("splits a long paragraph at sentence ends; its pieces share the line", () => {
    const long = Array.from({ length: 6 }, () => words(10)).join(" ");
    const b = localItems({ ...base, lines: [long], target: 20 });
    expect(b.length).toBe(3);
    const pieces = b.map((x) => (x.kind === "item" ? x.pieces[0] : null));
    expect(pieces.map((p) => [p?.s0, p?.s1])).toEqual([
      [0, 2],
      [2, 4],
      [4, -1],
    ]);
    expect(b.map((x) => (x.kind === "item" ? x.id : ""))).toEqual(["0.0", "0.2", "0.4"]);
  });

  it("never runs across a heading or a chapter start", () => {
    const lines = ["Chapter I", words(5), words(5), words(5)];
    const b = localItems({
      ...base,
      lines,
      headings: new Set([0]),
      chapterStarts: new Set([0, 2]),
      target: 100,
    });
    expect(b[0]).toEqual({ kind: "heading", line: 0 });
    expect(b.slice(1).map((x) => (x.kind === "item" ? x.pieces.map((p) => p.line) : []))).toEqual([
      [1],
      [2, 3],
    ]);
  });

  it("finds the block of a line, the first piece of a split paragraph", () => {
    const long = Array.from({ length: 6 }, () => words(10)).join(" ");
    const lines = ["Title", long, words(3)];
    const b = localItems({ ...base, lines, headings: new Set([0]), target: 20 });
    expect(blockOfLine(b, 0)).toBe(0);
    expect(blockOfLine(b, 1)).toBe(1);
    expect(blockLine(b[blockOfLine(b, 2)])).toBeLessThanOrEqual(2);
    // A position in the paragraph's third piece finds that piece.
    expect(blockOfAnchor(b, 1, 4)).toBe(3);
    expect(blockOfAnchor(b, 1, 2)).toBe(2);
    expect(blockOfAnchor(b, 1)).toBe(1);
  });

  it("speaks an item sentence by sentence, each with its address", () => {
    const lines = ["One. Two.", "Three."];
    const b = localItems({ ...base, lines, target: 100 });
    const c = new ParaCache(lines, "en");
    const parts = blockSpeech(
      b[0],
      (l) => c.get(l),
      (l) => lines[l],
    );
    expect(parts).toEqual([
      { text: "One.", line: 0, s: 0 },
      { text: "Two.", line: 0, s: 1 },
      { text: "Three.", line: 1, s: 0 },
    ]);
    const item = b[0];
    if (item.kind === "item") expect(pieceSentences(c.get(0), item.pieces[0]).length).toBe(2);
  });
});

describe("reader model: familiarity", () => {
  const rows: WordRow[] = [
    ["chat", 3, 0.9, 1, 0, 0],
    ["dort", 1, 0.1, 0, 0, 0],
    ["homme", 2, -1, 0, 0, 0, 1],
    ["paris", 1, -1, 0, 0, 1],
    ["zorg", 1, -1, 0, 0, 0, 0],
    ["liste", 1, -1, 0, 0, 0, 0],
  ];
  const fam = famMap(rows, (w) => w === "liste");

  it("marks mastered and names known, learning by band, new and unrecognised", () => {
    expect(fam.get("chat")).toBe("k");
    expect(fam.get("paris")).toBe("k");
    expect(fam.get("dort")).toBe("l1");
    expect(fam.get("homme")).toBe("n");
    expect(fam.get("liste")).toBe("n");
    expect(fam.get("zorg")).toBe("u");
    expect([learningBand(0), learningBand(0.5), learningBand(0.9)]).toEqual(["l1", "l2", "l3"]);
  });

  it("gives an item its coverage and a rail strength", () => {
    const p = cutPara("Le chat dort.", "fr");
    // "le" is not in the map: not counted.
    expect(itemCoverage(p.sentences, fam)).toBe(0.5);
    expect(railLevel(0.5)).toBe(2);
    expect(railLevel(1)).toBe(4);
    expect(railLevel(null)).toBe(-1);
  });
});

describe("reader chrome", () => {
  const vh = 800;
  it("reduces on his own scroll down, comes back on a deliberate scroll up", () => {
    let s = chromeStep(CHROME_FULL, { type: "scroll", dy: 30, y: 500, vh });
    expect(s.reduced).toBe(true);
    s = chromeStep(s, { type: "scroll", dy: -20, y: 480, vh });
    expect(s.reduced).toBe(true);
    s = chromeStep(s, { type: "scroll", dy: -80, y: 400, vh });
    expect(s.reduced).toBe(false);
  });

  it("is full at the top and after a tap", () => {
    const r = { reduced: true, back: 0 };
    expect(chromeStep(r, { type: "scroll", dy: -5, y: 0, vh }).reduced).toBe(false);
    expect(chromeStep(r, { type: "tap" }).reduced).toBe(false);
  });

  it("returns the same state when nothing changes (no re-render)", () => {
    const r = { reduced: true, back: 0 };
    expect(chromeStep(r, { type: "scroll", dy: 10, y: 300, vh })).toBe(r);
    expect(chromeStep(CHROME_FULL, { type: "scroll", dy: 0, y: 0, vh })).toBe(CHROME_FULL);
  });
});

describe("reader position", () => {
  const mem = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    };
  };

  it("stores an anchor, not pixels, and reads the first reader's line", () => {
    const s = mem();
    expect(loadAnchor("b", s)).toBeNull();
    s.setItem("lk:read-pos:b", "12");
    expect(loadAnchor("b", s)).toEqual({ line: 12, off: 0, at: 0 });
    saveAnchor("b", { line: 30, off: 0.25, at: 5 }, s);
    expect(loadAnchor("b", s)).toEqual({ line: 30, off: 0.25, at: 5 });
    // The first reader is gone: its key is only read, never written.
    expect(s.getItem("lk:read-pos:b")).toBe("12");
  });

  it("checks stored anchors and keeps the newest", () => {
    expect(parseAnchor({ line: -1 })).toBeNull();
    expect(parseAnchor({ line: 2, off: 3 })).toEqual({ line: 2, off: 0, at: 0 });
    const a = { line: 1, off: 0, at: 1 };
    const b = { line: 9, off: 0, at: 2 };
    expect(newestAnchor(a, b)).toBe(b);
    expect(newestAnchor(null, a)).toBe(a);
  });

  it("takes the block at the eye line", () => {
    const rects = [
      { line: 0, top: -200, height: 150 },
      { line: 4, top: -50, height: 300 },
      { line: 9, top: 250, height: 100 },
    ];
    expect(anchorAt(rects, 100, 7)).toEqual({ line: 4, off: 0.5, at: 7 });
    expect(anchorAt([{ line: 4, s: 2, top: 0, height: 100 }], 50, 1)).toEqual({
      line: 4,
      s: 2,
      off: 0.5,
      at: 1,
    });
    expect(parseAnchor({ line: 4, s: 2, off: 0.1, at: 3 })).toEqual({
      line: 4,
      s: 2,
      off: 0.1,
      at: 3,
    });
    expect(anchorAt(rects, 1000)).toBeNull();
  });
});

describe("local reader data", () => {
  it("grades and undoes in memory", async () => {
    const d = localReaderData();
    const book = {
      id: "b",
      lines: ["a b c."],
      headings: new Set<number>(),
      chapterStarts: new Set<number>(),
      lang: "en",
    };
    const [item] = (await d.load(book)).blocks;
    if (item.kind !== "item") throw new Error("item expected");
    const r1 = await d.grade(book, item, 3);
    await d.grade(book, item, 1);
    expect(d.lastGrade(item.id)).toBe(1);
    await d.undo(book, { ...r1, rating: 1 });
    expect(d.lastGrade(item.id)).toBe(3);
  });
});

describe("reader position: storage edges", () => {
  it("has no store without localStorage, and never throws", async () => {
    // No store at all: said explicitly, so a localStorage another test file left
    // on globalThis (Linux file order in the merge queue) cannot receive the write.
    expect(loadAnchor("x", null)).toBeNull();
    saveAnchor("x", { line: 1, off: 0, at: 1 }, null);
    const bad = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(loadAnchor("x", bad)).toBeNull();
    expect(() => saveAnchor("x", { line: 1, off: 0, at: 1 }, bad)).not.toThrow();
    expect(parseAnchor(null)).toBeNull();
    const d = localReaderData();
    expect(await d.anchor("x")).toBeNull();
    d.saveAnchor("x", { line: 2, off: 0, at: 2 });
    expect(d.lastGrade("none")).toBeNull();
    await d.undo(
      { id: "x", lines: [], headings: new Set(), chapterStarts: new Set(), lang: "en" },
      { itemId: "none", rating: 3, at: 0 },
    );
  });
});

describe("reader model: the backend's cuts and the EPUB's markup", () => {
  it("takes explicit sentence cuts, keeping the text exact", () => {
    const text = "Mrs. Dupont arrive. Elle rit.";
    expect(
      sentencesFromCuts(text, [
        [0, 19],
        [20, 29],
      ]),
    ).toEqual(["Mrs. Dupont arrive. ", "Elle rit."]);
    expect(sentencesFromCuts(text, [])).toEqual([text]);
    const p = cutPara(text, "fr", "fr", [
      [0, 19],
      [20, 29],
    ]);
    expect(p.sentences.length).toBe(2);
    expect(p.sentences.map((x) => x.text).join("")).toBe(text);
  });

  it("puts inline emphasis on the words it covers", () => {
    const p = cutPara("A very big cat.", "en", "en", null, [
      [2, 6, "em"],
      [7, 10, "strong"],
    ]);
    const segs = p.sentences[0].segs;
    expect(segs.find((g) => g.text === "very")?.k).toEqual(["em"]);
    expect(segs.find((g) => g.text === "big")?.k).toEqual(["strong"]);
    expect(segs.find((g) => g.text === "cat")?.k).toBeUndefined();
    const m = marksByLine([
      [3, 0, 2, "em"],
      [3, 4, 5, "sup"],
      [4, 0, 1, "script"],
    ]);
    expect(m.get(3)).toEqual([
      [0, 2, "em"],
      [4, 5, "sup"],
    ]);
    expect(m.has(4)).toBe(false);
    const c = new ParaCache(["A very cat."], "en", "en", 10, {
      cuts: () => [[0, 11]],
      marks: () => [[2, 6, "em"]],
    });
    expect(c.get(0).sentences[0].segs.find((g) => g.text === "very")?.k).toEqual(["em"]);
  });
});

describe("reader model: emphasis inside a word", () => {
  it("keeps H₂O one token, its digit in <sub>", () => {
    const p = cutPara("H2O boils.", "en", "en", null, [[1, 2, "sub"]]);
    const tok = p.sentences[0].segs.find((g) => g.t === 0);
    expect(tok?.parts).toEqual([{ text: "H" }, { text: "2", k: ["sub"] }, { text: "O" }]);
  });
});

describe("nextParaItem: a paragraph's grade moves on to the next paragraph (owner, 2026-11-08 20:33 JST)", () => {
  const blocks = [
    { kind: "heading", line: 0 },
    { kind: "item", id: "1.0", pieces: [{ line: 1, s0: 0, s1: 2 }] },
    { kind: "item", id: "1.2", pieces: [{ line: 1, s0: 2, s1: -1 }] },
    { kind: "heading", line: 2 },
    { kind: "item", id: "3.0", pieces: [{ line: 3, s0: 0, s1: -1 }] },
    { kind: "item", id: "4.0", pieces: [{ line: 4, s0: 0, s1: -1 }] },
  ] as Parameters<typeof nextParaItem>[0];
  it("skips the rest of a split paragraph and a heading", () => {
    expect(nextParaItem(blocks, 1)).toBe(4);
  });
  it("the item right after a whole paragraph", () => {
    expect(nextParaItem(blocks, 3)).toBe(5);
  });
  it("none after the last paragraph", () => {
    expect(nextParaItem(blocks, 4)).toBe(-1);
  });
});
