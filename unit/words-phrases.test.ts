import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GENERATED,
  SCENARIOS,
  isScenario,
  moveUnder,
  phraseHome,
  phraseProblems,
  phraseRowName,
  tatoebaId,
  tatoebaUrl,
  type PhraseEntry,
} from "@/lib/words/phrases";
import { flatten } from "@/lib/words/tree";
import { spokenText } from "@/lib/words/spoken";
import {
  CREDITS_END,
  CREDITS_START,
  buildPhraseDecks,
  isGenerated,
  mergeIndex,
  parseDrops,
  parseJsonl,
  withCredits,
  type CuratedLine,
} from "@/scripts/words/phrase-decks";

const ok = (e: Partial<PhraseEntry>): PhraseEntry => ({
  term: "お会計お願いします。",
  back: "Check, please.",
  src: GENERATED,
  ...e,
});

describe("phraseProblems", () => {
  it("accepts a well-formed card", () => {
    expect(
      phraseProblems(
        "ja",
        ok({ reading: "おかいけいおねがいします", register: "polite", src: tatoebaUrl(1) }),
      ),
    ).toEqual([]);
    expect(
      phraseProblems(
        "zh",
        ok({ term: "麻烦买单。", reading: "máfan mǎidān.", back: "The bill, please." }),
      ),
    ).toEqual([]);
  });

  it("checks length, script, register, src and readings", () => {
    expect(phraseProblems("ja", ok({ term: "あ".repeat(21) }))).toContain(
      "term over 20 characters",
    );
    expect(phraseProblems("zh", ok({ term: "我".repeat(15) }))).toContain(
      "term over 14 characters",
    );
    expect(phraseProblems("zh", ok({ term: "ありがとう" }))).toContain("kana in a Chinese phrase");
    expect(phraseProblems("ja", ok({ term: "OKです。" }))).toEqual([]);
    expect(phraseProblems("ja", ok({ term: "Yesです。" }))).toContain(
      "Latin letters or digits in term",
    );
    expect(phraseProblems("ja", ok({ term: "3時です。" }))).toContain(
      "Latin letters or digits in term",
    );
    expect(phraseProblems("ja", ok({ register: "formal" as never }))).toContain(
      'register "formal"',
    );
    expect(phraseProblems("ja", ok({ src: "tatoeba:12" }))).toContain('src "tatoeba:12"');
    expect(phraseProblems("ja", ok({ reading: "お会計" }))).toContain("reading not in kana");
    expect(phraseProblems("zh", ok({ term: "买单。", reading: "买单" }))).toContain(
      "reading not pinyin",
    );
    expect(phraseProblems("ja", ok({ back: "" }))).toContain("empty back");
  });
});

describe("tatoeba src", () => {
  it("round-trips the sentence id", () => {
    expect(tatoebaId(tatoebaUrl(4709))).toBe("4709");
    expect(tatoebaId(GENERATED)).toBeNull();
  });
});

describe("buildPhraseDecks", () => {
  const line = (term: string, src = GENERATED): CuratedLine => ({
    term,
    back: "x",
    register: "casual",
    src,
  });

  it("writes one deck per scenario, with index rows", () => {
    const b = buildPhraseDecks([
      { lang: "ja", scenario: "restaurant", lines: [line("いただきます。", "tatoeba:123")] },
    ]);
    expect(b.problems).toEqual([]);
    expect(b.lists).toEqual([
      expect.objectContaining({
        id: "ja-phrases-restaurant",
        kind: "phrase",
        scenario: "restaurant",
        count: 1,
        file: "ja-phrases-restaurant.json",
        name: "Japanese · Phrases · Restaurant and café",
      }),
    ]);
    const json = b.files[0].json as { entries: PhraseEntry[] };
    expect(json.entries[0].src).toBe("https://tatoeba.org/sentences/show/123");
  });

  it("leaves out drops, repeats across scenarios, and reports problems", () => {
    const b = buildPhraseDecks(
      [
        { lang: "ja", scenario: "greetings", lines: [line("どうも。"), line("おはよう。")] },
        {
          lang: "ja",
          scenario: "feelings",
          lines: [line("どうも。"), line("ごめん。"), line("ダメ。", "tatoeba:x")],
        },
      ],
      parseDrops("# owner drops\nja\tおはよう。\n"),
    );
    const terms = (id: string) =>
      (
        b.files.find((f) => f.file === `${id}.json`)!.json as { entries: PhraseEntry[] }
      ).entries.map((e) => e.term);
    expect(terms("ja-phrases-greetings")).toEqual(["どうも。"]);
    expect(terms("ja-phrases-feelings")).toEqual(["ごめん。"]);
    expect(b.problems).toEqual(['ja-feelings: ダメ。: src "tatoeba:x"']);
  });

  it("credits each deck's Tatoeba sentences in SOURCES.md", () => {
    const b = buildPhraseDecks([
      {
        lang: "zh",
        scenario: "restaurant",
        lines: [
          { term: "干杯！", back: "Cheers!", src: "tatoeba:42", by: "someone" },
          { term: "麻烦买单。", back: "Check, please.", src: GENERATED },
        ],
      },
      { lang: "zh", scenario: "hotel", lines: [{ term: "几点退房？", back: "x", src: GENERATED }] },
    ]);
    expect(
      b.files.map((f) => (f.json as { entries: PhraseEntry[] }).entries.filter(isGenerated).length),
    ).toEqual([1, 1]);
    const md = `# S\n\n${CREDITS_START}\nold\n${CREDITS_END}\n\nrest\n`;
    const out = withCredits(md, b.credits);
    expect(out).toContain(
      "- `zh-phrases-restaurant`: [#42](https://tatoeba.org/sentences/show/42) someone",
    );
    expect(out).toContain("- `zh-phrases-hotel`: no Tatoeba sentences");
    expect(out).not.toContain("old");
    expect(out.endsWith(`${CREDITS_END}\n\nrest\n`)).toBe(true);
    expect(withCredits("no markers", b.credits)).toBe("no markers");
  });

  it("parses jsonl with comments and blank lines", () => {
    expect(parseJsonl('// c\n\n{"term":"a","back":"b","src":"generated"}\n')).toHaveLength(1);
  });
});

describe("mergeIndex", () => {
  it("keeps word lists, puts phrase decks after their language's lists", () => {
    const words = [
      { id: "ja-jlpt-n5", lang: "ja" },
      { id: "zh-hsk-1", lang: "zh" },
      { id: "ja-phrases-work", lang: "ja", kind: "phrase", scenario: "work" },
    ];
    const fresh = buildPhraseDecks([
      {
        lang: "ja",
        scenario: "greetings",
        lines: [{ term: "やあ。", back: "Hi.", src: GENERATED }],
      },
    ]).lists;
    expect(mergeIndex(words, fresh, ["ja"]).map((l) => l.id)).toEqual([
      "ja-jlpt-n5",
      "ja-phrases-greetings",
      "zh-hsk-1",
    ]);
    // A language not rebuilt keeps its decks.
    expect(mergeIndex(words, [], ["zh"]).map((l) => l.id)).toContain("ja-phrases-work");
  });
});

describe("the tree: language → Phrases → scenario", () => {
  type L = { id: string; parentId: string | null; lang: string; name: string; source: string };
  const isGroup = (l: L) => l.source === "group:words";
  const isPhrase = (l: L) => l.source.includes("-phrases-");
  const tree: L[] = [
    { id: "g", parentId: null, lang: "ja", name: "Japanese", source: "group:words" },
    { id: "n5", parentId: "g", lang: "ja", name: "Japanese · JLPT N5", source: "ja-jlpt-n5" },
    { id: "fr", parentId: null, lang: "fr", name: "French", source: "fr-freq-1" },
  ];

  it("finds the language group, and no Phrases group yet", () => {
    expect(phraseHome(flatten(tree), "ja", isGroup, isPhrase, "Phrases")).toEqual({
      langGroup: "g",
      phrasesGroup: null,
    });
  });

  it("finds a Phrases group by its decks, or an empty one by name", () => {
    const withP: L[] = [
      ...tree,
      { id: "p", parentId: "g", lang: "ja", name: "フレーズ", source: "group:words" },
      { id: "r", parentId: "p", lang: "ja", name: "x", source: "ja-phrases-restaurant" },
    ];
    expect(phraseHome(flatten(withP), "ja", isGroup, isPhrase, "Phrases")).toEqual({
      langGroup: "g",
      phrasesGroup: "p",
    });
    const empty: L[] = [
      ...tree,
      { id: "e", parentId: "g", lang: "ja", name: "phrases", source: "group:words" },
    ];
    expect(phraseHome(flatten(empty), "ja", isGroup, isPhrase, "Phrases").phrasesGroup).toBe("e");
  });

  it("moves a row to be the last child of a group", () => {
    const nodes: L[] = [
      ...tree,
      { id: "new", parentId: null, lang: "ja", name: "x", source: "ja-phrases-work" },
    ];
    expect(moveUnder(flatten(nodes), "new", "g")).toEqual([
      { id: "g", parentId: null },
      { id: "n5", parentId: "g" },
      { id: "new", parentId: "g" },
      { id: "fr", parentId: null },
    ]);
    // Never under itself.
    expect(moveUnder(flatten(nodes), "g", "n5")).toEqual(
      flatten(nodes).map((r) => ({ id: r.id, parentId: r.parentId })),
    );
  });

  it("names a deck by its place in the tree, unless renamed", () => {
    const labels = { phrases: "フレーズ", scenario: "レストランとカフェ" };
    const cat = "Japanese · Phrases · Restaurant and café";
    const list = { name: cat, lang: "ja" };
    expect(phraseRowName(list, cat, { lang: "ja" }, true, labels)).toBe("レストランとカフェ");
    expect(phraseRowName(list, cat, { lang: "ja" }, false, labels)).toBe(
      "フレーズ · レストランとカフェ",
    );
    expect(phraseRowName(list, cat, null, false, labels)).toBe(
      "Japanese · フレーズ · レストランとカフェ",
    );
    expect(phraseRowName({ name: "Mine", lang: "ja" }, cat, null, false, labels)).toBeNull();
  });
});

describe("spoken text", () => {
  it("reads a Japanese phrase as written, a word by its kana", () => {
    const phrase = { term: "お会計お願いします。", reading: "おかいけいおねがいします", back: "" };
    expect(spokenText(phrase, "ja", true)).toBe("お会計お願いします。");
    expect(spokenText({ term: "外", reading: "そと", back: "" }, "ja", true)).toBe("そと");
    expect(
      spokenText(
        { term: "いただきます", reading: "いただきます", back: "", scene: "x" },
        "ja",
        true,
      ),
    ).toBe("いただきます");
  });
});

// The decks shipped in public/words: the format the client reads.
describe("public/words phrase decks", () => {
  const dir = "public/words";
  const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")).lists as {
    id: string;
    lang: string;
    kind?: string;
    scenario?: string;
    count: number;
    file: string;
    source: string;
    license: string;
  }[];
  const decks = index.filter((l) => l.kind === "phrase");

  it("has every scenario for ja and zh", () => {
    for (const lang of ["ja", "zh"])
      expect(decks.filter((d) => d.lang === lang).map((d) => d.scenario)).toEqual([...SCENARIOS]);
  });

  it("keeps the word lists in place", () => {
    expect(index.filter((l) => l.kind !== "phrase").length).toBeGreaterThan(50);
    expect(index.find((l) => l.id === "ja-jlpt-n5")).toBeTruthy();
  });

  it.each(decks.map((d) => [d.id, d] as const))("%s is well formed", (_id, d) => {
    expect(isScenario(d.scenario)).toBe(true);
    expect(d.id).toBe(`${d.lang}-phrases-${d.scenario}`);
    expect(d.source).toContain("Tatoeba");
    expect(existsSync(join(dir, d.file))).toBe(true);
    const deck = JSON.parse(readFileSync(join(dir, d.file), "utf8"));
    expect(deck.kind).toBe("phrase");
    expect(deck.entries).toHaveLength(d.count);
    expect(d.count).toBeGreaterThanOrEqual(20);
    const terms = new Set<string>();
    for (const e of deck.entries as PhraseEntry[]) {
      expect(phraseProblems(d.lang, e)).toEqual([]);
      expect(e.register).toBeDefined();
      expect(e.note).toBeTruthy();
      expect(terms.has(e.term)).toBe(false);
      terms.add(e.term);
    }
    const regs = new Set((deck.entries as PhraseEntry[]).map((e) => e.register));
    expect(regs.size).toBe(2);
  });
});
