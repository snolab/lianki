// scripts/words/senses.ts: which CC-CEDICT senses an HSK word's back gets.
import { describe, expect, it } from "bun:test";
import { hskSenses, isMarkedSense, joinSenses, truncate } from "@/scripts/words/senses";

describe("hskSenses", () => {
  // The shape complete-hsk-vocabulary gives 云 (HSK 2).
  const yun = [
    { t: "云", i: { y: "yún" }, m: ["(classical) to say"] },
    { t: "雲", i: { y: "Yún" }, m: ["surname Yun", "abbr. for Yunnan Province 云南省"] },
    { t: "雲", i: { y: "yún" }, m: ["cloud"] },
  ];
  it("a word whose first form is only classical: the plain sense first, the classical one kept after", () => {
    const s = hskSenses(yun, "云");
    expect(s.reading).toBe("yún");
    expect(joinSenses(s.senses, 80)).toBe("cloud; (classical) to say");
  });
  it("a tie between plain forms keeps the first, as the lists were built", () => {
    const zhong = [
      { t: "中", i: { y: "zhōng" }, m: ["within", "among", "(dialect) OK"] },
      { t: "中", i: { y: "zhòng" }, m: ["to hit (the mark)", "to be hit by", "to suffer"] },
    ];
    expect(hskSenses(zhong, "中").reading).toBe("zhōng");
  });
  it("a proper-noun reading loses to a common one; notes are dropped", () => {
    const yi = [
      { t: "以", i: { y: "Yǐ" }, m: ["abbr. for Israel 以色列", "Israel", "Israeli"] },
      { t: "以", i: { y: "yǐ" }, m: ["to use", "by means of"] },
    ];
    const s = hskSenses(yi, "以");
    expect(s.reading).toBe("yǐ");
    expect(s.senses).toEqual(["to use", "by means of"]);
  });
  it("a same-reading form spelled as another character is another word, left out", () => {
    const fan = [
      { t: "帆", i: { y: "fān" }, m: ["sail"] },
      { t: "颿", i: { y: "fān" }, m: ["to gallop"] },
    ];
    expect(hskSenses(fan, "帆").senses).toEqual(["sail"]);
  });
  it("joinSenses: repeats dropped, at most three, a long first sense cut at a boundary", () => {
    expect(joinSenses(["cloud.", "Cloud", "sky", "air", "heaven"])).toBe("cloud; sky; air");
    expect(joinSenses(["a fairly long first sense", "and a second one"], 30)).toBe(
      "a fairly long first sense",
    );
    expect(joinSenses(["word ".repeat(30).trim()], 40)).toBe(`${"word ".repeat(7).trim()}…`);
    expect(joinSenses(["one, two, three, four, five, six, seven"], 30)).toBe(
      "one, two, three, four, five",
    );
    expect(truncate("x".repeat(50), 20)).toBe(`${"x".repeat(19)}…`);
  });
  it("register marks", () => {
    expect(isMarkedSense("(classical) to say")).toBe(true);
    expect(isMarkedSense("(literary) to give")).toBe(true);
    expect(isMarkedSense("(of rain) to fall")).toBe(false);
  });
});
