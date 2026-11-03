import { describe, expect, it } from "bun:test";
import {
  COMBO_MS,
  type ComboCtx,
  type Hit,
  type Unit,
  comboClick,
  countSentences,
  decodeUnit,
  encodeUnit,
  firstUnit,
  nextUnit,
  sentenceOfToken,
  tokenOffset,
  tokenText,
  tokenWord,
  unitHolds,
  unitLink,
} from "@/lib/read/reader-select";
import { cutPara, type Fam } from "@/lib/read/reader-model";
import { isBookHash, resolveReadId } from "@/lib/read/book-link";

// Two chapters: lines [0, 10) and [10, 20).
const ctx = (phrases: Record<string, [number, number]> = {}, chapters = true): ComboCtx => ({
  interval: COMBO_MS,
  phraseAt: (line, t) => {
    for (const [k, r] of Object.entries(phrases))
      if (Number(k) === line && t >= r[0] && t <= r[1]) return r;
    return null;
  },
  chapterAt: (line) => (chapters ? (line < 10 ? 0 : 1) : -1),
  chapterRange: (n) =>
    chapters
      ? ((
          [
            [0, 10],
            [10, 20],
          ] as [number, number][]
        )[n] ?? null)
      : null,
});

const word: Hit = { line: 3, s: 1, t: 7 };

/** Clicks at the given times on one hit: the kinds selected. */
function clicks(hit: Hit, times: number[], c = ctx()): Unit["kind"][] {
  let st = null;
  const out: Unit["kind"][] = [];
  for (const at of times) {
    st = comboClick(st, hit, at, c);
    out.push(st.unit.kind);
  }
  return out;
}

describe("combo-click levels", () => {
  it("one level up per quick click, phrase skipped without phrase data", () => {
    expect(clicks(word, [0, 200, 400, 600, 800, 1000])).toEqual([
      "word",
      "sentence",
      "para",
      "chapter",
      "book",
      "book",
    ]);
  });

  it("the phrase level when extraction gives the word a phrase", () => {
    expect(clicks(word, [0, 100, 200, 300], ctx({ 3: [6, 8] }))).toEqual([
      "word",
      "phrase",
      "sentence",
      "para",
    ]);
    const st = comboClick(
      comboClick(null, word, 0, ctx({ 3: [6, 8] })),
      word,
      100,
      ctx({ 3: [6, 8] }),
    );
    expect(st.unit).toEqual({ kind: "phrase", line: 3, t0: 6, t1: 8 });
  });

  it("a one-word phrase is skipped (it is the word again)", () => {
    expect(clicks(word, [0, 100], ctx({ 3: [7, 7] }))).toEqual(["word", "sentence"]);
  });

  it("a pause ends the combo: the next click starts at the word again", () => {
    expect(clicks(word, [0, 200, 200 + COMBO_MS + 1])).toEqual(["word", "sentence", "word"]);
    // Exactly the interval still counts.
    expect(clicks(word, [0, COMBO_MS])).toEqual(["word", "sentence"]);
  });

  it("each click is timed from the last one, not from the first", () => {
    const step = COMBO_MS - 10;
    expect(clicks(word, [0, step, 2 * step, 3 * step])).toEqual([
      "word",
      "sentence",
      "para",
      "chapter",
    ]);
  });

  it("a click outside the selected unit starts a new combo there", () => {
    const c = ctx();
    let st = comboClick(null, word, 0, c);
    st = comboClick(st, word, 100, c); // sentence 1 of line 3
    st = comboClick(st, { line: 3, s: 2, t: 12 }, 200, c);
    expect(st.unit).toEqual({ kind: "word", line: 3, t: 12 });
  });

  it("inside a larger unit the combo carries on from anywhere in it", () => {
    const c = ctx();
    let st = comboClick(null, word, 0, c);
    st = comboClick(st, word, 100, c);
    st = comboClick(st, word, 200, c); // paragraph 3
    st = comboClick(st, { line: 3, s: 0, t: 0 }, 300, c);
    expect(st.unit).toEqual({ kind: "chapter", n: 0 });
    st = comboClick(st, { line: 8, s: 0, t: 2 }, 400, c); // still chapter 0
    expect(st.unit).toEqual({ kind: "book" });
  });

  it("a heading starts at its paragraph (no word, no sentence)", () => {
    expect(clicks({ line: 10, s: null, t: null }, [0, 100, 200])).toEqual([
      "para",
      "chapter",
      "book",
    ]);
  });

  it("between words: the sentence first", () => {
    expect(firstUnit({ line: 3, s: 1, t: null }, ctx())).toEqual({
      kind: "sentence",
      line: 3,
      s: 1,
    });
  });

  it("a book without chapters goes from paragraph to the book", () => {
    expect(clicks(word, [0, 100, 200, 300], ctx({}, false))).toEqual([
      "word",
      "sentence",
      "para",
      "book",
    ]);
  });

  it("clock going backwards never extends", () => {
    expect(clicks(word, [500, 100])).toEqual(["word", "word"]);
  });

  it("unitHolds and nextUnit agree on the levels", () => {
    const c = ctx();
    expect(unitHolds({ kind: "chapter", n: 1 }, { line: 10, s: 0, t: 0 }, c)).toBe(true);
    expect(unitHolds({ kind: "chapter", n: 1 }, { line: 9, s: 0, t: 0 }, c)).toBe(false);
    expect(unitHolds({ kind: "phrase", line: 3, t0: 6, t1: 8 }, word, c)).toBe(true);
    expect(nextUnit({ kind: "book" }, word, c)).toEqual({ kind: "book" });
  });
});

describe("deep links", () => {
  const units: [Unit, string][] = [
    [{ kind: "word", line: 12, t: 3 }, "#w=12.3"],
    [{ kind: "phrase", line: 12, t0: 3, t1: 5 }, "#ph=12.3-5"],
    [{ kind: "sentence", line: 120, s: 2 }, "#s=120.2"],
    [{ kind: "para", line: 0 }, "#p=0"],
    [{ kind: "chapter", n: 4 }, "#ch=4"],
    [{ kind: "book" }, ""],
  ];
  it("encode and decode round-trip", () => {
    for (const [u, h] of units) {
      expect(encodeUnit(u)).toBe(h);
      if (h) {
        expect(decodeUnit(h)).toEqual(u);
        expect(decodeUnit(h.slice(1))).toEqual(u);
      }
    }
  });
  it("anything else decodes to nothing", () => {
    for (const bad of [
      "",
      "#",
      "#w=1",
      "#w=1.2.3",
      "#s=-1.2",
      "#p=01",
      "#ph=1.5-3",
      "#ph=1.3-3",
      "#ch=x",
      "#w=99999999.1",
      "#p=1&x=2",
      "#P=1",
      "#reading",
    ])
      expect(decodeUnit(bad)).toBeNull();
    expect(decodeUnit(null)).toBeNull();
  });
  it("a link names the book and the unit", () => {
    expect(
      unitLink("https://lianki.com", "3f2a9c0d41b7e6aa", { kind: "sentence", line: 5, s: 1 }),
    ).toBe("https://lianki.com/read/3f2a9c0d41b7e6aa#s=5.1");
    expect(unitLink("https://lianki.com", "3f2a9c0d41b7e6aa", { kind: "book" })).toBe(
      "https://lianki.com/read/3f2a9c0d41b7e6aa",
    );
  });
});

describe("unit text and familiarity", () => {
  const p = cutPara("The cat sat. A dog ran home.", "en");
  const ss = p.sentences;
  it("tokens count across the paragraph; offsets point into the line", () => {
    expect(tokenText(ss, 3, 3)).toBe("A");
    expect(tokenText(ss, 4, 6)).toBe("dog ran home");
    expect(sentenceOfToken(ss, 4)).toBe(1);
    expect(sentenceOfToken(ss, 99)).toBe(-1);
    const line = "The cat sat. A dog ran home.";
    expect(line.slice(tokenOffset(ss, 4), tokenOffset(ss, 4) + 3)).toBe("dog");
    expect(tokenWord(ss, 1)).toBe(ss[0].segs.find((g) => g.t === 1)!.w);
  });
  it("counts running words by class, optionally a token range", () => {
    const toks = ss.flatMap((s) => s.segs.filter((g) => g.w));
    const fam = new Map<string, Fam>();
    const cls: Fam[] = ["u", "n", "l2", "k"];
    toks.forEach((g, i) => fam.set(g.w!, cls[i % 4]));
    const all = countSentences(ss, fam);
    expect(all.n).toBe(toks.length);
    expect(all.known + all.learning + all.fresh + all.unrecognised).toBe(all.n);
    expect(all.unrecognised).toBe(toks.filter((_, i) => i % 4 === 0).length);
    const [a, b] = [toks[1].t, toks[2].t];
    expect(countSentences(ss, fam, [a, b])).toEqual({
      n: 2,
      known: 0,
      learning: 1,
      fresh: 1,
      unrecognised: 0,
    });
    // Words off the map are not counted.
    expect(countSentences(ss, new Map()).n).toBe(0);
  });
});

describe("link access (lib/read/book-link.ts)", () => {
  const owned: Record<string, Record<string, string>> = {
    alice: { "3f2a9c0d41b7e6aa": "m-alice-1" },
    bob: {},
  };
  const find = async (user: string, hash: string) => owned[user]?.[hash] ?? null;

  it("only 16 hex digits are a book hash", () => {
    expect(isBookHash("3f2a9c0d41b7e6aa")).toBe(true);
    expect(isBookHash("3F2A9C0D41B7E6AA")).toBe(false);
    expect(isBookHash("6543a1b2c3d4e5f6a7b8c9d0")).toBe(false); // an ObjectId
    expect(isBookHash("0b8f7a52-6f36-4c1e-9d3a-1f2e3d4c5b6a")).toBe(false); // a UUID
  });
  it("a hash opens the user's own copy of that text", async () => {
    expect(await resolveReadId("3f2a9c0d41b7e6aa", "alice", find)).toEqual({
      kind: "redirect",
      id: "m-alice-1",
    });
  });
  it("without the text, or signed out: 404, the same as a hash of nothing", async () => {
    expect(await resolveReadId("3f2a9c0d41b7e6aa", "bob", find)).toEqual({ kind: "none" });
    expect(await resolveReadId("3f2a9c0d41b7e6aa", null, find)).toEqual({ kind: "none" });
    expect(await resolveReadId("0000000000000000", "alice", find)).toEqual({ kind: "none" });
  });
  it("only the signed-in user's materials are searched", async () => {
    const seen: string[] = [];
    await resolveReadId("3f2a9c0d41b7e6aa", "bob", async (u, h) => {
      seen.push(u);
      return find(u, h);
    });
    expect(seen).toEqual(["bob"]);
  });
  it("a material id passes through (its API checks the owner)", async () => {
    expect(await resolveReadId("m-alice-1", "bob", find)).toEqual({
      kind: "material",
      id: "m-alice-1",
    });
  });
});
