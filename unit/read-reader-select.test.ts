import { describe, expect, it } from "bun:test";
import {
  COMBO_MS,
  type ComboCtx,
  type Hit,
  type Unit,
  RANGE_MAX_LINES,
  comboClick,
  countRange,
  countSentences,
  decodeUnit,
  encodeUnit,
  firstUnit,
  nextUnit,
  partText,
  rangeText,
  rangeUnit,
  sentenceOfToken,
  snapIndices,
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
    [{ kind: "range", l0: 3, t0: 4, l1: 5, t1: 1 }, "#r=3.4-5.1"],
    [{ kind: "range", l0: 7, t0: 0, l1: 7, t1: 2 }, "#r=7.0-7.2"],
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
      // A range runs forwards, over more than one word, and not past the cap.
      "#r=5.1-3.4",
      "#r=3.4-3.4",
      "#r=3.4-3.2",
      "#r=3.4",
      "#r=3.4-5",
      "#r=3.-5.1",
      `#r=0.0-${RANGE_MAX_LINES + 1}.0`,
    ])
      expect(decodeUnit(bad)).toBeNull();
    expect(decodeUnit(null)).toBeNull();
  });
  it("a link names the book and the unit", () => {
    expect(
      unitLink("https://lianki.com", "3f2a9c0d41b7e6aa", { kind: "sentence", line: 5, s: 1 }),
    ).toBe("https://lianki.com/read/3f2a9c0d41b7e6aa#s=5.1");
    expect(
      unitLink("https://lianki.com", "3f2a9c0d41b7e6aa", {
        kind: "range",
        l0: 2,
        t0: 7,
        l1: 4,
        t1: 0,
      }),
    ).toBe("https://lianki.com/read/3f2a9c0d41b7e6aa#r=2.7-4.0");
    expect(decodeUnit(`#r=0.0-${RANGE_MAX_LINES}.0`)).not.toBeNull();
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

describe("a hand-made selection (manual range)", () => {
  // Three paragraphs as the reader lays them out: every word with its
  // offsets in one running text, paragraphs separated by "\n".
  const text = ["The cat sat. A dog ran.", "Rain fell — all night.", "Morning came."];
  const paras = text.map((l) => cutPara(l, "en").sentences);
  const toks: { line: number; t: number; a: number; b: number }[] = [];
  let base = 0;
  paras.forEach((ss, line) => {
    let off = base;
    for (const s of ss)
      for (const g of s.segs) {
        if (g.t >= 0) toks.push({ line, t: g.t, a: off, b: off + g.text.length });
        off += g.text.length;
      }
    base += text[line].length + 1;
  });
  const at = (line: number, needle: string, k = 0) =>
    text.slice(0, line).reduce((n, l) => n + l.length + 1, 0) + text[line].indexOf(needle) + k;
  /** The unit a selection [s, e) of the running text snaps to. */
  const snap = (s: number, e: number) => {
    const ij = snapIndices(
      toks.length,
      (i) => s < toks[i].b,
      (i) => e > toks[i].a,
    );
    return ij && rangeUnit(toks[ij[0]], toks[ij[1]]);
  };

  it("snaps to whole words, from inside a word to inside another", () => {
    // From inside "cat" to inside "dog": both whole.
    expect(snap(at(0, "cat", 2), at(0, "dog", 2))).toEqual({
      kind: "range",
      l0: 0,
      t0: 1,
      l1: 0,
      t1: 4,
    });
  });
  it("spans paragraphs, keeping each end's own token", () => {
    const u = snap(at(0, "ran", 1), at(2, "Morning", 3));
    expect(u).toEqual({ kind: "range", l0: 0, t0: 5, l1: 2, t1: 0 });
    const get = (l: number) => paras[l] ?? null;
    expect(rangeText(u as Extract<Unit, { kind: "range" }>, get)).toBe(
      "ran.\n\nRain fell — all night.\n\nMorning",
    );
    expect(rangeText(u as Extract<Unit, { kind: "range" }>, get, " ")).toBe(
      "ran. Rain fell — all night. Morning",
    );
  });
  it("a selection ending right after a word, or starting right before one, takes no more", () => {
    // "cat" exactly, then " sat" with its leading space.
    expect(snap(at(0, "cat"), at(0, "cat", 3))).toEqual({ kind: "word", line: 0, t: 1 });
    expect(snap(at(0, "cat", 3), at(0, "sat", 3))).toEqual({ kind: "word", line: 0, t: 2 });
  });
  it("only spaces or punctuation: no unit", () => {
    expect(snap(at(1, "—"), at(1, "—", 1))).toBeNull();
    expect(snap(at(0, ". A"), at(0, ". A", 1))).toBeNull();
    // A newline between paragraphs.
    expect(snap(at(0, "ran.", 4), at(1, "Rain"))).toBeNull();
  });
  it("the ends come in either order", () => {
    expect(rangeUnit({ line: 2, t: 0 }, { line: 0, t: 3 })).toEqual({
      kind: "range",
      l0: 0,
      t0: 3,
      l1: 2,
      t1: 0,
    });
  });
  it("part text and counts follow the range's ends", () => {
    expect(partText(paras[0], 3, null)).toBe("A dog ran.");
    expect(partText(paras[0], null, 1)).toBe("The cat");
    const fam = new Map<string, Fam>();
    for (const ss of paras) for (const s of ss) for (const g of s.segs) if (g.w) fam.set(g.w, "n");
    const u = { kind: "range", l0: 0, t0: 4, l1: 1, t1: 1 } as const;
    // dog ran | Rain fell
    expect(countRange(u, (l) => paras[l] ?? null, fam).n).toBe(4);
    // A blank line in the middle is skipped.
    expect(countRange({ ...u, l1: 2, t1: 0 }, (l) => (l === 1 ? null : paras[l]), fam).n).toBe(3);
  });
  it("a range's link opens only for who has the book (404 otherwise)", async () => {
    const link = unitLink("https://lianki.com", "3f2a9c0d41b7e6aa", {
      kind: "range",
      l0: 0,
      t0: 1,
      l1: 2,
      t1: 0,
    });
    const url = new URL(link);
    // The fragment never reaches the server: access is the path's alone.
    const id = url.pathname.split("/").pop()!;
    const find = async (u: string, h: string) =>
      u === "alice" && h === "3f2a9c0d41b7e6aa" ? "m-alice-1" : null;
    expect(await resolveReadId(id, "alice", find)).toEqual({ kind: "redirect", id: "m-alice-1" });
    expect(await resolveReadId(id, "bob", find)).toEqual({ kind: "none" });
    expect(await resolveReadId(id, null, find)).toEqual({ kind: "none" });
    expect(decodeUnit(url.hash)).toEqual({ kind: "range", l0: 0, t0: 1, l1: 2, t1: 0 });
  });
  it("a range is no combo level: a click in it starts at the word", () => {
    const r: Unit = { kind: "range", l0: 0, t0: 1, l1: 2, t1: 0 };
    expect(unitHolds(r, { line: 1, s: 0, t: 0 }, ctx())).toBe(true);
    expect(unitHolds(r, { line: 0, s: 0, t: 0 }, ctx())).toBe(false);
    expect(nextUnit(r, { line: 1, s: 0, t: 0 }, ctx()).kind).toBe("word");
  });
});
