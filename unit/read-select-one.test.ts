// One selection at a time in the reader (owner, 2026-11-05 03:00 JST:
// "连点两个不同词，两个都会高亮"): a tap on another word starts over at that word,
// and drawing a unit takes the mark off every element of the one before.
import { describe, expect, it } from "bun:test";
import { COMBO_MS, type ComboCtx, comboClick } from "@/lib/read/reader-select";
import { markSelected } from "@/lib/read/select-mark";

const ctx: ComboCtx = {
  interval: COMBO_MS,
  // Tokens 2–4 of line 0 are a phrase.
  phraseAt: (line, t) => (line === 0 && t >= 2 && t <= 4 ? [2, 4] : null),
  chapterAt: () => -1,
  chapterRange: () => null,
};

describe("combo: another word starts over", () => {
  it("a quick tap on a different word selects only that word", () => {
    const a = comboClick(null, { line: 0, s: 0, t: 2 }, 0, ctx);
    expect(a.unit).toEqual({ kind: "word", line: 0, t: 2 });
    // Inside the interval, inside the same phrase even: still a new word.
    const b = comboClick(a, { line: 0, s: 0, t: 3 }, 80, ctx);
    expect(b.unit).toEqual({ kind: "word", line: 0, t: 3 });
    const c = comboClick(b, { line: 1, s: 0, t: 5 }, 160, ctx);
    expect(c.unit).toEqual({ kind: "word", line: 1, t: 5 });
  });
  it("the same word again climbs to its phrase; then another word starts over", () => {
    const a = comboClick(null, { line: 0, s: 0, t: 3 }, 0, ctx);
    const b = comboClick(a, { line: 0, s: 0, t: 3 }, 80, ctx);
    expect(b.unit).toEqual({ kind: "phrase", line: 0, t0: 2, t1: 4 });
    const c = comboClick(b, { line: 1, s: 0, t: 0 }, 1000, ctx);
    expect(c.unit).toEqual({ kind: "word", line: 1, t: 0 });
  });
});

/** Just enough of an element and a root for markSelected. */
class El {
  attrs = new Map<string, string>();
  constructor(readonly name: string) {}
  hasAttribute(k: string) {
    return this.attrs.has(k);
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  removeAttribute(k: string) {
    this.attrs.delete(k);
  }
}
const rootOf = (els: El[]) =>
  ({
    querySelectorAll: (sel: string) => {
      expect(sel).toBe("[data-sel]");
      return els.filter((e) => e.hasAttribute("data-sel"));
    },
  }) as unknown as ParentNode;
const marked = (els: El[]) => els.filter((e) => e.hasAttribute("data-sel")).map((e) => e.name);

describe("markSelected: one unit drawn", () => {
  const els = ["a", "b", "c", "d"].map((n) => new El(n));
  const root = rootOf(els);
  const pick = (...n: string[]) => els.filter((e) => n.includes(e.name)) as unknown as Element[];
  it("marks the unit", () => {
    markSelected(root, pick("a"));
    expect(marked(els)).toEqual(["a"]);
  });
  it("a new unit takes the mark off the old one", () => {
    markSelected(root, pick("c"));
    expect(marked(els)).toEqual(["c"]);
  });
  it("a stray mark (a row painted before) goes too", () => {
    els[3].setAttribute("data-sel", "");
    markSelected(root, pick("a", "b"));
    expect(marked(els)).toEqual(["a", "b"]);
  });
  it("nothing selected: nothing marked", () => {
    markSelected(root, []);
    expect(marked(els)).toEqual([]);
  });
});
