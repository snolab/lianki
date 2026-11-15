// packages/debug-chat/src/lane-phonetic.ts: lane names matched by sound.
import { afterEach, describe, expect, it } from "bun:test";
import {
  FINAL_NEAR,
  INITIAL_NEAR,
  PHONETIC_MAX_NEAR_DEFAULT,
  compareSyllables,
  nameSyllables,
  phoneticMaxNear,
  phoneticPrefix,
  setPhoneticMaxNear,
  splitSyllable,
  toneless,
} from "../packages/debug-chat/src/lane-phonetic";
import { pinyinOf } from "../packages/debug-chat/src/wake-tokens";

afterEach(() => setPhoneticMaxNear(PHONETIC_MAX_NEAR_DEFAULT));

describe("syllables", () => {
  it("splits initial and final", () => {
    expect(splitSyllable("zhang")).toEqual(["zh", "ang"]);
    expect(splitSyllable("jie")).toEqual(["j", "ie"]);
    expect(splitSyllable("er")).toEqual(["", "er"]);
  });
  it("drops tones, keeps ü", () => {
    expect(toneless("jié")).toBe("jie");
    expect(toneless("lǜ")).toBe("lü");
  });
  it("reads a Han name, refuses Latin, mixed and one-syllable names", () => {
    expect(nameSyllables("杰咪", pinyinOf)).toEqual(["jie", "mi"]);
    expect(nameSyllables("小克", pinyinOf)).toEqual(["xiao", "ke"]);
    expect(nameSyllables("杰my", pinyinOf)).toBeNull();
    expect(nameSyllables("coco", pinyinOf)).toBeNull();
    expect(nameSyllables("咪", pinyinOf)).toBeNull();
    expect(nameSyllables("杰\u{20000}", pinyinOf)).toBeNull();
  });
});

describe("compareSyllables (data tables)", () => {
  it("the tables are data: every group has at least two members", () => {
    for (const g of [...INITIAL_NEAR, ...FINAL_NEAR]) expect(g.length).toBeGreaterThan(1);
  });
  it.each([
    ["jie", "jie", "same"],
    ["qie", "jie", "near"],
    ["xie", "jie", "near"],
    ["zhi", "zi", "near"],
    ["nan", "lan", "near"],
    ["min", "ming", "near"],
    ["jian", "jiang", "near"],
    ["ji", "jie", "near"],
    ["he", "ke", null],
    ["mu", "mi", null],
    ["mian", "mi", null],
    ["qi", "jie", null],
    ["a", "e", null],
  ] as const)("%s vs %s → %s", (a, b, want) => {
    expect(compareSyllables(a, b)).toBe(want);
  });
});

describe("phoneticPrefix", () => {
  const jiemi = ["jie", "mi"];
  it("matches the same pinyin in any characters, any tone", () => {
    expect(phoneticPrefix("解密，在吗", jiemi, pinyinOf)).toBe(2);
    expect(phoneticPrefix("借米", jiemi, pinyinOf)).toBe(2);
  });
  it("allows near syllables up to the cap", () => {
    expect(phoneticPrefix("切咪", jiemi, pinyinOf)).toBe(2);
    expect(phoneticPrefix("切咪", jiemi, pinyinOf, 0)).toBe(-1);
    expect(phoneticPrefix("鸡咪", jiemi, pinyinOf, 1)).toBe(2);
    expect(phoneticPrefix("切民", ["jie", "ming"], pinyinOf, 1)).toBe(-1);
    expect(phoneticPrefix("切民", ["jie", "ming"], pinyinOf, 2)).toBe(2);
  });
  it("reads the cap from config when not given", () => {
    setPhoneticMaxNear(0);
    expect(phoneticMaxNear()).toBe(0);
    expect(phoneticPrefix("切咪", jiemi, pinyinOf)).toBe(-1);
    expect(setPhoneticMaxNear(-1)).toBe(0);
    expect(setPhoneticMaxNear("2")).toBe(0);
    expect(setPhoneticMaxNear(9)).toBe(0);
    expect(setPhoneticMaxNear(2)).toBe(2);
  });
  it("refuses false friends, short lines, Latin and unknown characters", () => {
    expect(phoneticPrefix("节目", jiemi, pinyinOf)).toBe(-1);
    expect(phoneticPrefix("街面", jiemi, pinyinOf)).toBe(-1);
    expect(phoneticPrefix("小鸡", ["xiao", "ke"], pinyinOf)).toBe(-1);
    expect(phoneticPrefix("杰", jiemi, pinyinOf)).toBe(-1);
    expect(phoneticPrefix("杰m", jiemi, pinyinOf)).toBe(-1);
    expect(phoneticPrefix("杰\u{20000}", jiemi, pinyinOf)).toBe(-1);
  });
});
