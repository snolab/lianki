import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { meaningText } from "@/lib/words/say-parts";
import { spokenText } from "@/lib/words/spoken";
import {
  byFrequency,
  chineseBack,
  csvRows,
  formsOf,
  ipa,
  isHeadword,
  mergeExamIndex,
  parseEcdict,
  parseRanked,
  rankedEntries,
  tagged,
  toEntry,
  type ExamListMeta,
} from "@/scripts/words/exam-decks";

describe("chineseBack", () => {
  it("keeps three senses per part of speech, the part of speech in brackets", () => {
    expect(chineseBack("vt. 放弃, 抛弃, 遗弃, 使屈从, 沉溺, 放纵\\nn. 放任, 无拘束, 狂热")).toBe(
      "(vt.) 放弃，抛弃，遗弃；(n.) 放任，无拘束，狂热",
    );
  });
  it("drops field-tagged and web lines, and merges a repeated part of speech", () => {
    expect(chineseBack("n. 上下文, 背景\\n[医] 关联\\nn. 上下文\\n[网络] 语境")).toBe(
      "(n.) 上下文，背景",
    );
  });
  it("says adj. for ECDICT's a.", () => {
    expect(chineseBack("a. 椭圆的\\n[医] 椭圆形的")).toBe("(adj.) 椭圆的");
  });
  it("is empty when only field-tagged lines are left", () => {
    expect(chineseBack("[计] 膝上型电脑")).toBe("");
  });
  it("stops adding parts of speech past the length limit, but always keeps one", () => {
    const long =
      "n. 一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六";
    expect(chineseBack(`${long}\\nv. 走`)).toBe(`(n.) ${long.slice(3)}`);
  });
  it("is read aloud from its first sense, without the part of speech", () => {
    expect(meaningText(chineseBack("vt. 放弃, 抛弃\\nn. 放任"))).toBe("放弃");
  });
});

describe("ipa", () => {
  it("turns ECDICT's notation into IPA between slashes", () => {
    expect(ipa("ә'bændәn")).toBe("/əˈbændən/");
    expect(ipa(".insti'tju:ʃәnәlaizd")).toBe("/ˌinstiˈtjuːʃənəlaizd/");
    expect(ipa("'єәpɒ:t")).toBe("/ˈɛəpɒːt/");
  });
  it("gives no reading for an empty or garbled one", () => {
    expect(ipa("")).toBe("");
    expect(ipa("^ab\\c")).toBe("");
  });
  it("is never read aloud", () => {
    expect(spokenText({ term: "abandon", reading: "/əˈbændən/", back: "放弃" }, "en", false)).toBe(
      "abandon",
    );
  });
});

describe("headwords and forms", () => {
  it("keeps lowercase words, drops names and abbreviations", () => {
    for (const w of ["abandon", "o'clock", "father-in-law", "a", "I"])
      expect(isHeadword(w)).toBe(true);
    for (const w of ["Africa", "B.C.", "i.e.", "CORE", "-ism", "trans-"])
      expect(isHeadword(w)).toBe(false);
  });
  it("reads inflections from the exchange column, not lemma pointers", () => {
    expect(formsOf("d:abandoned/p:abandoned/i:abandoning/3:abandons")).toEqual([
      "abandoned",
      "abandoning",
      "abandons",
    ]);
    expect(formsOf("0:abandon/1:p")).toEqual([]);
  });
});

describe("ECDICT rows", () => {
  const csv = [
    "word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange,detail,audio",
    'zest,zest,,"n. 兴趣, 热情\\nvt. 给...调味",,,,cet6 gre,14392,10079,s:zests,,',
    'abandon,ә\'bændәn,,"vt. 放弃",,,,gk cet4 cet6 gre,2057,2182,,,',
    "Africa,,,n. 非洲,,,,cet4,0,0,,,",
    "rare,,,a. 稀有的,,,,cet6,0,0,,,",
  ].join("\n");
  const rows = parseEcdict(csv);
  it("parses quoted fields with commas", () => {
    expect(rows.map((r) => r.word)).toEqual(["zest", "abandon", "Africa", "rare"]);
    expect(rows[0].translation).toBe("n. 兴趣, 热情\\nvt. 给...调味");
    expect(rows[0].forms).toEqual(["zests"]);
  });
  it("selects a tag minus another, without names, by frequency", () => {
    expect(tagged(rows, "cet4").map((r) => r.word)).toEqual(["abandon"]);
    expect(
      tagged(rows, "cet6", ["cet4"])
        .sort(byFrequency)
        .map((r) => r.word),
    ).toEqual(["zest", "rare"]);
  });
});

describe("cards", () => {
  const row = (word: string, translation: string, phonetic = "") => ({
    word,
    phonetic,
    translation,
    tag: "",
    bnc: 0,
    frq: 0,
    forms: [`${word}s`],
  });
  const examples = (w: string, forms: string[]) =>
    w === "zest" && forms.includes("zests") ? "Add zest." : undefined;
  it("carries the Chinese back, IPA and an example found by the word's forms", () => {
    expect(toEntry(row("zest", "n. 兴趣", "zest"), examples)).toEqual({
      term: "zest",
      reading: "/zest/",
      back: "(n.) 兴趣",
      ex: "Add zest.",
    });
    expect(toEntry(row("laptop", "[计] 膝上型电脑"), examples)).toBeNull();
  });
  it("keeps a ranked list's order and reports words with no meaning", () => {
    const dict = new Map([
      ["zest", row("zest", "n. 兴趣")],
      ["laptop", row("laptop", "[计] 膝上型电脑")],
    ]);
    const out = rankedEntries(["zest", "laptop", "online"], (w) => dict.get(w), examples);
    expect(out.entries.map((e) => e.term)).toEqual(["zest"]);
    expect(out.missing).toEqual(["laptop", "online"]);
  });
  it("parses a last field cut off by the end of the file", () => {
    expect([...csvRows('a,"b')]).toEqual([["a", "b"]]);
  });
});

describe("parseRanked", () => {
  it("orders by rank, lowercases Excel's TRUE, keeps I, skips the header", () => {
    expect(parseRanked("﻿Lemma,Rank\nTRUE,3\nI,2\nthe,1\nthe,9\n")).toEqual(["the", "I", "true"]);
  });
});

describe("mergeExamIndex", () => {
  const meta = (id: string): ExamListMeta => ({
    id,
    lang: "en",
    name: id,
    level: id,
    kind: "exam",
    exam: "X",
    count: 1,
    file: `${id}.json`,
    source: "",
    license: "",
  });
  it("replaces old exam decks and puts them after word lists, before phrase decks", () => {
    const existing = [
      { id: "ja-jlpt-n5", lang: "ja" },
      { id: "en-freq-1", lang: "en" },
      { id: "en-exam-old", lang: "en", kind: "exam" },
      { id: "en-phrases-x", lang: "en", kind: "phrase" },
      { id: "ko-freq-1", lang: "ko" },
    ];
    expect(mergeExamIndex(existing, [meta("en-exam-cet4")]).map((l) => l.id)).toEqual([
      "ja-jlpt-n5",
      "en-freq-1",
      "en-exam-cet4",
      "en-phrases-x",
      "ko-freq-1",
    ]);
  });
});

describe("the shipped exam decks", () => {
  const dir = join(import.meta.dir, "../public/words");
  const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")).lists as {
    id: string;
    kind?: string;
    exam?: string;
    count: number;
    file: string;
    source: string;
    license: string;
  }[];
  const exams = index.filter((l) => l.kind === "exam");
  it("are listed with an exam, a source and a licence", () => {
    expect(exams.length).toBeGreaterThanOrEqual(11);
    for (const l of exams) {
      expect(l.exam).toBeTruthy();
      expect(l.source).toContain("ECDICT");
      expect(l.license).toContain("MIT");
    }
  });
  it("JLPT and HSK levels are grouped under their exam", () => {
    expect(index.filter((l) => l.id.startsWith("ja-jlpt-")).every((l) => l.exam === "JLPT")).toBe(
      true,
    );
    expect(index.filter((l) => l.id.startsWith("zh-hsk-")).every((l) => l.exam === "HSK 3.0")).toBe(
      true,
    );
  });
  it("each file has unique terms, a Chinese back on every card, and the listed count", () => {
    for (const l of exams) {
      expect(existsSync(join(dir, l.file))).toBe(true);
      const deck = JSON.parse(readFileSync(join(dir, l.file), "utf8"));
      const entries = deck.entries as { term: string; back: string; reading?: string }[];
      expect(entries.length).toBe(l.count);
      expect(new Set(entries.map((e) => e.term)).size).toBe(entries.length);
      for (const e of entries) {
        expect(e.back).toMatch(/\p{Script=Han}/u);
        if (e.reading) expect(e.reading).toMatch(/^\/.+\/$/);
      }
    }
  });
});
