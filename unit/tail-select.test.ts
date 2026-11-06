// Selecting in a live Google Doc's tail (lib/read/tail-select.ts).
import { describe, expect, it } from "bun:test";
import { cutPara } from "@/lib/read/reader-model";
import {
  LATEST_SENTENCES,
  latestPlan,
  tailHolds,
  tailHtml,
  tailNext,
  tailPlan,
  tailRange,
  type TailUnit,
} from "@/lib/read/tail-select";

const paras = ["One two. Three four. Five six.", "Seven eight. Nine ten."].map((p) =>
  cutPara(p, "en"),
);
const texts = (u: TailUnit | null) => tailPlan(u, paras)?.map((b) => b.map((x) => x.text));

describe("the combo", () => {
  it("goes word, sentence, paragraph, and stops", () => {
    const w: TailUnit = { kind: "word", p: 0, s: 1, t: 2 };
    const s = tailNext(w)!;
    expect(s).toEqual({ kind: "sentence", p: 0, s: 1 });
    const para = tailNext(s)!;
    expect(para).toEqual({ kind: "para", p: 0 });
    expect(tailNext(para)).toBeNull();
  });
});

describe("tailHolds", () => {
  it("knows each kind's reach", () => {
    expect(tailHolds({ kind: "word", p: 0, s: 0, t: 1 }, 0, 0, 1)).toBe(true);
    expect(tailHolds({ kind: "word", p: 0, s: 0, t: 1 }, 0, 0, 2)).toBe(false);
    expect(tailHolds({ kind: "sentence", p: 0, s: 1 }, 0, 1, 9)).toBe(true);
    expect(tailHolds({ kind: "sentence", p: 0, s: 1 }, 0, 2, 9)).toBe(false);
    expect(tailHolds({ kind: "para", p: 1 }, 1, 5, 9)).toBe(true);
    expect(tailHolds({ kind: "para", p: 1 }, 0, 0, 0)).toBe(false);
    const r = tailRange({ p: 1, s: 0 }, { p: 0, s: 1 });
    expect(r).toEqual({ kind: "range", p0: 0, s0: 1, p1: 1, s1: 0 });
    expect(tailHolds(r, 0, 0, 0)).toBe(false);
    expect(tailHolds(r, 0, 2, 0)).toBe(true);
    expect(tailHolds(r, 1, 0, 0)).toBe(true);
    expect(tailHolds(r, 1, 1, 0)).toBe(false);
    expect(tailHolds(r, 2, 0, 0)).toBe(false);
  });
});

describe("tailPlan", () => {
  it("does not translate a word, or nothing", () => {
    expect(tailPlan(null, paras)).toBeNull();
    expect(texts({ kind: "word", p: 0, s: 0, t: 0 })).toBeUndefined();
    expect(tailPlan({ kind: "para", p: 9 }, paras)).toBeNull();
  });
  it("is whole sentences, a block per paragraph", () => {
    expect(texts({ kind: "sentence", p: 0, s: 1 })).toEqual([["Three four."]]);
    expect(texts({ kind: "para", p: 1 })).toEqual([["Seven eight.", "Nine ten."]]);
    expect(texts(tailRange({ p: 0, s: 1 }, { p: 1, s: 0 }))).toEqual([
      ["Three four.", "Five six."],
      ["Seven eight."],
    ]);
  });
});

describe("latestPlan", () => {
  const plan = (t: string, resting: boolean) =>
    latestPlan([cutPara(t, "en")], resting)
      ?.flat()
      .map((x) => x.text);
  it("follows the newest whole sentences, a bounded number", () => {
    const six = "A one. B two. C three. D four. E five. F six.";
    const out = plan(six, false)!;
    expect(out).toHaveLength(LATEST_SENTENCES);
    expect(out.at(-1)).toBe("F six.");
  });
  it("adds the sentence still being written only once the text rests", () => {
    expect(plan("Done here. Still writ", false)).toEqual(["Done here."]);
    expect(plan("Done here. Still writ", true)).toEqual(["Done here.", "Still writ"]);
  });
  it("knows finished sentences in other scripts, closing quotes too", () => {
    expect(latestPlan([cutPara("今日は寒い。", "ja")], false)?.flat()).toHaveLength(1);
    expect(latestPlan([cutPara("「はい。」", "ja")], false)?.flat()).toHaveLength(1);
  });
  it("looks back a paragraph when the last has nothing to show, and may have nothing", () => {
    const paragraphs = ["Earlier one.", "unfinished"].map((p) => cutPara(p, "en"));
    expect(
      latestPlan(paragraphs, false)
        ?.flat()
        .map((x) => x.text),
    ).toEqual(["Earlier one."]);
    expect(latestPlan([], true)).toBeNull();
    expect(latestPlan([cutPara("unfinished", "en")], false)).toBeNull();
  });
});

describe("tailHtml", () => {
  it("is the book and the tail, escaped, without empty lines", () => {
    expect(tailHtml(["a<b", " "], "c&d\n\ne")).toBe(
      "<html><body><p>a&lt;b</p><p>c&amp;d</p><p>e</p></body></html>",
    );
  });
});
