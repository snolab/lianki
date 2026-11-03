import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { meaningText } from "@/lib/words/say-parts";
import { spokenText } from "@/lib/words/spoken";
import {
  byFrequency,
  csvRows,
  exchangeOf,
  isCrudeSense,
  isHeadword,
  isOffensive,
  joinParts,
  mergeExamIndex,
  parseEcdict,
  parseGlosses,
  parseRanked,
  simplified,
  tagged,
  toEntry,
  usesWord,
  wiktBack,
  wiktIpa,
  type ExamListMeta,
  type WiktEntry,
} from "@/scripts/words/exam-decks";

const entry = (pos: string, tr: [string, string][], ipa: WiktEntry["ipa"] = []): WiktEntry => ({
  word: "x",
  pos,
  tr: tr.map(([w, s]) => ({ w, s })),
  ipa,
  glosses: [],
});

describe("wiktBack", () => {
  it("takes the simplified form: the main sense twice, then the next sense", () => {
    const state = entry("noun", [
      ["狀態 /状态", "a condition"],
      ["狀況 /状况", "a condition"],
      ["國家 /国家", "a sovereign country"],
      ["州", "a federal division"],
    ]);
    expect(wiktBack([state])).toBe("(n.) 状态，状况，国家");
  });
  it("keeps Wiktionary's part-of-speech order and skips entries without Chinese", () => {
    const even = [
      entry("adj", [
        ["平坦", "flat"],
        ["偶數 /偶数", "divisible by two"],
      ]),
      entry("noun", []),
      entry("adv", [
        ["甚至", "implying extreme example"],
        ["更加", "emphasising comparative"],
      ]),
    ];
    expect(wiktBack(even)).toBe("(adj.) 平坦，偶数；(adv.) 甚至，更加");
  });
  it("merges two entries of one part of speech and ignores non-Han and long translations", () => {
    expect(
      wiktBack([
        entry("verb", [["放棄 /放弃", "give up"]]),
        entry("verb", [
          ["fangqi", "give up"],
          ["一二三四五六七八九", "too long"],
          ["遺棄 /遗弃", "desert"],
        ]),
      ]),
    ).toBe("(v.) 放弃，遗弃");
  });
  it("is empty without translations, and stops at the length limit", () => {
    expect(wiktBack([entry("noun", [])])).toBe("");
    expect(joinParts(["(n.) 一二三四五六七八九十", "(v.) 走"], 12)).toBe(
      "(n.) 一二三四五六七八九十",
    );
  });
  it("is read aloud from its first sense, without the part of speech", () => {
    expect(meaningText("(v.) 放弃，遗弃；(n.) 工具")).toBe("放弃");
  });
  it("simplified() keeps a single form as is", () => {
    expect(simplified("工具")).toBe("工具");
    expect(simplified("實施 /实施")).toBe("实施");
  });
});

describe("crude senses and example words", () => {
  it("drops slang, vulgar and sexual senses and swear words, keeps the rest", () => {
    expect(isCrudeSense({ w: "被動 /被动", s: "slang: penetrated partner in sex" })).toBe(true);
    expect(isCrudeSense({ w: "肏！", s: "hell!" })).toBe(true);
    expect(isCrudeSense({ w: "寸止", s: "to stop just short" })).toBe(true);
    expect(isCrudeSense({ w: "條子 /条子", s: "police officer" })).toBe(true);
    expect(isCrudeSense({ w: "底部", s: "lowest part" })).toBe(false);
    expect(isCrudeSense({ w: "女性", s: "belonging to the female sex" })).toBe(false);
    const bottom = entry("noun", [
      ["底部", "lowest part"],
      ["被動 /被动", "slang: penetrated partner in sex"],
    ]);
    expect(wiktBack([bottom])).toBe("(n.) 底部");
  });
  it("an example must use the word or a form as a whole word", () => {
    expect(usesWord("I'm a temp.", "temperature", ["temperatures"])).toBe(false);
    expect(usesWord("It's my ship.", "relationship", [])).toBe(false);
    expect(usesWord("I have a temperature.", "temperature", [])).toBe(true);
    expect(usesWord("They studied it.", "study", [])).toBe(true);
    expect(usesWord("She went home.", "go", ["went"])).toBe(true);
    expect(usesWord("What is self-harm?", "self", [])).toBe(false);
  });
});

describe("wiktIpa", () => {
  it("prefers the British pronunciation, else the first plain one", () => {
    const e = entry(
      "verb",
      [],
      [
        { ipa: "/ɹɪˈvɝs/", tags: ["US"] },
        { ipa: "/ɹɪˈvɜːs/", tags: ["UK"] },
      ],
    );
    expect(wiktIpa([e])).toBe("/ɹɪˈvɜːs/");
    expect(
      wiktIpa([
        entry(
          "noun",
          [],
          [
            { ipa: "[ˈtʰæp]", tags: [] },
            { ipa: "/tæp/", tags: [] },
          ],
        ),
      ]),
    ).toBe("/tæp/");
    expect(wiktIpa([entry("noun", [])])).toBe("");
    // a heteronym takes the sound of the meaning the back leads with
    const lead = [
      entry("verb", [["帶領 /带领", "guide"]], [{ ipa: "/liːd/", tags: [] }]),
      entry("noun", [["鉛 /铅", "metal"]], [{ ipa: "/lɛd/", tags: ["UK"] }]),
    ];
    expect(wiktIpa(lead)).toBe("/liːd/");
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
  it("reads inflections and the lemma from the exchange column", () => {
    expect(exchangeOf("d:abandoned/p:abandoned/i:abandoning/3:abandons")).toEqual({
      forms: ["abandoned", "abandoning", "abandons"],
    });
    expect(exchangeOf("0:drug/1:s")).toEqual({ forms: [], lemma: "drug" });
  });
});

describe("ECDICT rows", () => {
  const csv = [
    "word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange,detail,audio",
    'zest,zest,,"n. 兴趣, 热情",,,,cet6 gre,14392,10079,s:zests,,',
    "abandon,,,vt. 放弃,,,,gk cet4 cet6 gre,2057,2182,,,",
    "Africa,,,n. 非洲,,,,cet4,0,0,,,",
    "rare,,,a. 稀有的,,,,cet6,0,0,,,",
    "drug,,,n. 药,,,,cet6,900,800,s:drugs,,",
    "drugs,,,n. 药,,,,cet6,950,850,0:drug/1:s,,",
  ].join("\n");
  const rows = parseEcdict(csv);
  it("parses quoted fields with commas, and the forms", () => {
    expect(rows.map((r) => r.word)).toEqual(["zest", "abandon", "Africa", "rare", "drug", "drugs"]);
    expect(rows[0].forms).toEqual(["zests"]);
  });
  it("selects a tag minus another, without names or folded plurals, by frequency", () => {
    expect(tagged(rows, "cet4").map((r) => r.word)).toEqual(["abandon"]);
    expect(
      tagged(rows, "cet6", ["cet4"])
        .sort(byFrequency)
        .map((r) => r.word),
    ).toEqual(["drug", "zest", "rare"]);
  });
  it("parses a last field cut off by the end of the file", () => {
    expect([...csvRows('a,"b')]).toEqual([["a", "b"]]);
  });
});

describe("cards", () => {
  const examples = (w: string, forms: string[]) =>
    w === "zest" && forms.includes("zests")
      ? { ex: "Add zest.", exSrc: "tatoeba:1", exBy: "CK" }
      : undefined;
  it("carries the Chinese back, IPA and a credited example found by the word's forms", () => {
    const wikt = [entry("noun", [["熱情 /热情", "enthusiasm"]], [{ ipa: "/zɛst/", tags: [] }])];
    expect(toEntry({ word: "zest", wikt, forms: ["zests"] }, examples)).toEqual({
      term: "zest",
      reading: "/zɛst/",
      back: "(n.) 热情",
      ex: "Add zest.",
      exSrc: "tatoeba:1",
      exBy: "CK",
    });
  });
  it("a written meaning overrides Wiktionary's", () => {
    const wikt = [entry("noun", [["薄膜", "thin layer"]])];
    expect(
      toEntry({ word: "film", wikt, written: "(n.) 电影，胶片", forms: [] }, examples)?.back,
    ).toBe("(n.) 电影，胶片");
  });
  it("uses the written meaning when Wiktionary has no Chinese, and none without either", () => {
    const wikt = [entry("noun", [])];
    expect(
      toEntry({ word: "laptop", wikt, written: "(n.) 笔记本电脑", forms: [] }, examples)?.back,
    ).toBe("(n.) 笔记本电脑");
    expect(toEntry({ word: "laptop", wikt, forms: [] }, examples)).toBeNull();
  });
  it("reads the written meanings file, skipping comments", () => {
    expect(parseGlosses("# note\nlaptop\t(n.) 笔记本电脑\n\nbad\t\n")).toEqual(
      new Map([["laptop", "(n.) 笔记本电脑"]]),
    );
  });
  it("keeps offensive sentences off the cards", () => {
    expect(isOffensive("Fuck your resume.")).toBe(true);
    expect(isOffensive("He put a dick joke in.")).toBe(true);
    expect(isOffensive("Send me your résumé.")).toBe(false);
    expect(isOffensive("Dickens wrote it.")).toBe(false);
    expect(isOffensive("Why is masturbation so stigmatized?")).toBe(true);
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
    expect(exams.map((l) => l.id).sort()).toEqual([
      "en-exam-cet4",
      "en-exam-cet6",
      "en-exam-gk",
      "en-exam-ky",
      "en-exam-zk",
      "en-nawl",
      "en-ngsl",
      "en-tsl",
    ]);
    for (const l of exams) {
      expect(l.exam).toBeTruthy();
      expect(l.source).toContain("Wiktionary");
      expect(l.license).toContain("CC BY-SA 4.0");
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
  it("each file has unique terms, a Chinese back, credited clean examples, and the listed count", () => {
    for (const l of exams) {
      expect(existsSync(join(dir, l.file))).toBe(true);
      const deck = JSON.parse(readFileSync(join(dir, l.file), "utf8"));
      const entries = deck.entries as {
        term: string;
        back: string;
        reading?: string;
        ex?: string;
        exSrc?: string;
      }[];
      expect(entries.length).toBe(l.count);
      expect(new Set(entries.map((e) => e.term)).size).toBe(entries.length);
      for (const e of entries) {
        expect(e.back).toMatch(/\p{Script=Han}/u);
        if (e.reading) expect(e.reading).toMatch(/^\/.+\/$/);
        if (e.ex) {
          expect(e.exSrc).toMatch(/^(tatoeba:\d+|wiktionary)$/);
          expect(isOffensive(e.ex)).toBe(false);
        }
      }
    }
  });
});
