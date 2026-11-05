// lib/read/sense-pick.ts and the language a word in a mixed book is read in.
// Made-up sentences only.
import { describe, expect, it } from "bun:test";
import {
  checkPicks,
  choiceOf,
  ctxHash,
  langLabel,
  pickFor,
  pickKey,
  PICKS_MAX,
  senseView,
  voiceLangOf,
  withPick,
  type SenseEntry,
} from "@/lib/read/sense-pick";
import { detectLangs, langIn } from "@/lib/read/lang-detect";
import { checkPref } from "@/lib/prefs/schema";

const ZH: SenseEntry = {
  lang: "zh",
  term: "云",
  back: "cloud; (classical) to say",
  reading: "yún",
};
const JA: SenseEntry = { lang: "ja", term: "雲", back: "cloud", reading: "くも" };

describe("the language of a word in a book that mixes languages", () => {
  const lines = [
    "We went hiking on Sunday and the weather was great.",
    "空に白い云が浮かんでいた。",
    "The view from the top was worth it.",
    "雨の日は家で本を読む。",
  ];
  it("each line has its own language, detected from the lines (no stored runs)", () => {
    expect(detectLangs(lines)).toEqual(["en", "ja", "en", "ja"]);
  });
  it("a Han word in a Japanese line is Japanese, not Chinese", () => {
    expect(langIn("云", ["en", "ja"], "ja")).toBe("ja");
    expect(langIn("雲", ["en", "ja"], "ja")).toBe("ja");
  });
  it("the same word in a Chinese line is Chinese", () => {
    expect(detectLangs(["今天天上没有云。"])).toEqual(["zh"]);
    expect(langIn("云", ["zh"], "zh")).toBe("zh");
  });
});

describe("senseView", () => {
  it("another language's entry alone is shown, labelled as that language's", () => {
    const v = senseView([ZH], "ja", null)!;
    expect(v.main).toBe(ZH);
    expect(v.cross).toBe(true);
    expect(v.others).toEqual([]);
  });
  it("the word's own language's entry comes first; the other is offered", () => {
    const v = senseView([ZH, JA], "ja", null)!;
    expect(v.main).toBe(JA);
    expect(v.cross).toBe(false);
    expect(v.others).toEqual([ZH]);
    expect(v.picked).toBe(false);
  });
  it("his pick wins, and says so", () => {
    const v = senseView([ZH, JA], "ja", choiceOf(ZH))!;
    expect(v.main).toBe(ZH);
    expect(v.picked).toBe(true);
    expect(v.cross).toBe(true);
  });
  it("a stale pick (no such entry now) falls back to the own language", () => {
    expect(senseView([ZH, JA], "ja", "ko\t구름")!.main).toBe(JA);
  });
  it("repeats are dropped; nothing found is null", () => {
    expect(senseView([JA, { ...JA }], "ja", null)!.others).toEqual([]);
    expect(senseView([], "ja", null)).toBeNull();
  });
});

describe("picks: per word and sentence, the latest for the word elsewhere", () => {
  const s1 = "空に白い云が浮かんでいた。";
  const s2 = "云は東へ流れていく。";
  it("keys are the word and its sentence's hash", () => {
    expect(ctxHash(s1)).toMatch(/^[0-9a-f]{8}$/);
    expect(ctxHash(s1)).toBe(ctxHash(s1));
    expect(ctxHash(s1)).not.toBe(ctxHash(s2));
    expect(pickKey(" 云 ", s1)).toBe(`云@${ctxHash(s1)}`);
  });
  it("the pick here, else his latest for the word, else none", () => {
    let p = withPick({}, "云", s1, choiceOf(ZH));
    expect(pickFor(p, "云", s1)).toBe(choiceOf(ZH));
    expect(pickFor(p, "云", s2)).toBe(choiceOf(ZH));
    p = withPick(p, "云", s2, choiceOf(JA));
    expect(pickFor(p, "云", s1)).toBe(choiceOf(ZH));
    expect(pickFor(p, "云", "云がない。")).toBe(choiceOf(JA));
    expect(pickFor(p, "雨", s1)).toBeNull();
  });
  it("keeps the newest PICKS_MAX, under the account pref's cap", () => {
    let p = {};
    for (let i = 0; i < PICKS_MAX + 5; i++) p = withPick(p, `語${i}`, `文${i}`, choiceOf(JA));
    expect(Object.keys(p).length).toBe(PICKS_MAX);
    expect(pickFor(p, "語0", "文0")).toBeNull();
    expect(checkPref("read.sensePicks", p)).toEqual(p);
  });
  it("untrusted stored picks: only well-formed ones", () => {
    const good = withPick({}, "云", s1, choiceOf(ZH));
    expect(checkPicks({ ...good, x: "zh\t云", "a@12345678": 3 })).toEqual(good);
    expect(checkPicks("nope")).toEqual({});
    expect(checkPref("read.sensePicks", { "http://localhost@12345678": "zh\t云" })).toBeUndefined();
  });
  it("the voice follows the pick, else the word's own language", () => {
    expect(voiceLangOf(choiceOf(ZH), "ja")).toBe("zh");
    expect(voiceLangOf(null, "ja")).toBe("ja");
    expect(voiceLangOf("bad", "ja")).toBe("ja");
  });
  it("a language's name in the UI language", () => {
    expect(langLabel("zh", "en")).toBe("Chinese");
    expect(langLabel("ja", "zh")).toBe("日语");
  });
});
