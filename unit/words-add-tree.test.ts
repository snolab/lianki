import { describe, expect, test } from "bun:test";
import {
  buildAddTree,
  COVERAGE_TARGETS,
  coverageBands,
  defaultOpen,
  freqListsOf,
  leavesOf,
  tickState,
  tickedInOrder,
  toggleTick,
  type AddMeta,
} from "@/lib/words/add-tree";

const catalog: AddMeta[] = [
  { id: "ja-jlpt-n5", lang: "ja", exam: "JLPT" },
  { id: "ja-jlpt-n4", lang: "ja", exam: "JLPT" },
  { id: "ja-phrases-small-talk", lang: "ja", kind: "phrase", scenario: "small-talk" },
  { id: "ja-phrases-greetings", lang: "ja", kind: "phrase", scenario: "greetings" },
  { id: "en-freq-1", lang: "en" },
  { id: "en-freq-2", lang: "en" },
  { id: "en-exam-cet4", lang: "en", kind: "exam", exam: "CET" },
  { id: "en-tsl", lang: "en", kind: "exam", exam: "TOEIC" },
];
const tree = buildAddTree(catalog, ["greetings", "small-talk"]);
const none = new Set<string>();

describe("add tree", () => {
  test("language → family → exam → list, phrases by scenario order", () => {
    expect(tree.map((n) => n.key)).toEqual(["lang:ja", "lang:en"]);
    const ja = tree[0];
    if (ja.kind !== "lang") throw 0;
    expect(ja.children.map((n) => n.key)).toEqual(["ja/exam", "ja/phrases"]);
    expect(leavesOf(ja.children[1]).map((m) => m.id)).toEqual([
      "ja-phrases-greetings",
      "ja-phrases-small-talk",
    ]);
    const en = tree[1];
    if (en.kind !== "lang") throw 0;
    expect(en.children.map((n) => n.key)).toEqual(["en/freq", "en/exam"]);
    const exam = en.children[1];
    if (exam.kind !== "family") throw 0;
    expect(exam.children.map((n) => n.key)).toEqual(["en/exam/CET", "en/exam/TOEIC"]);
  });

  test("ticking a language ticks everything under it not yet added", () => {
    const added = new Set(["ja-jlpt-n5"]);
    const t = toggleTick(tree[0], none, added);
    expect([...t].sort()).toEqual(["ja-jlpt-n4", "ja-phrases-greetings", "ja-phrases-small-talk"]);
    expect(tickState(tree[0], t, added)).toEqual({ checked: true, mixed: false, disabled: false });
    // a second tap unticks it all; the added list stays checked (mixed)
    const off = toggleTick(tree[0], t, added);
    expect(off.size).toBe(0);
    expect(tickState(tree[0], off, added).mixed).toBe(true);
  });

  test("a partly ticked branch is mixed; a tap completes it", () => {
    const t = new Set(["en-freq-1"]);
    expect(tickState(tree[1], t, none)).toEqual({ checked: false, mixed: true, disabled: false });
    expect(toggleTick(tree[1], t, none).size).toBe(4);
  });

  test("a branch whose lists are all added is checked and disabled", () => {
    const ja = tree[0];
    if (ja.kind !== "lang") throw 0;
    const added = new Set(["ja-jlpt-n5", "ja-jlpt-n4"]);
    expect(tickState(ja.children[0], none, added)).toEqual({
      checked: true,
      mixed: false,
      disabled: true,
    });
    expect(toggleTick(ja.children[0], none, added).size).toBe(0);
  });

  test("ticked lists come back in tree order", () => {
    const t = new Set(["en-tsl", "ja-jlpt-n4", "en-freq-1"]);
    expect(tickedInOrder(tree, t).map((m) => m.id)).toEqual(["ja-jlpt-n4", "en-freq-1", "en-tsl"]);
  });

  test("his own languages open by default, else the browser's", () => {
    const own = defaultOpen(tree, ["en"], ["ja-JP"]);
    expect(own.has("lang:en") && own.has("en/exam/CET")).toBe(true);
    expect(own.has("lang:ja")).toBe(false);
    expect(defaultOpen(tree, [], ["ja-JP", "fr"]).has("lang:ja")).toBe(true);
    expect(defaultOpen(tree, ["mul"], []).size).toBe(0);
  });
});

describe("coverage bands", () => {
  const fr = [
    { id: "fr-freq-1", level: "1–500", coverage: 0.75 },
    { id: "fr-freq-2", level: "501–1000", coverage: 0.808 },
    { id: "fr-freq-3", level: "1001–1500", coverage: 0.839 },
  ];
  test("the fewest top lists reaching each target; unreached targets give none", () => {
    expect(coverageBands(fr)).toEqual([
      { ids: ["fr-freq-1"], coverage: 0.75, top: 500 },
      { ids: ["fr-freq-1", "fr-freq-2"], coverage: 0.808, top: 1000 },
    ]);
  });
  test("targets reached by the same lists give one band", () => {
    expect(coverageBands(fr, [0.5, 0.6, 0.7]).length).toBe(1);
  });
  test("no coverage data, no bands", () => {
    expect(coverageBands([{ id: "x-freq-1", level: "1–500" }])).toEqual([]);
  });
});

describe("every language in the catalogs", () => {
  const { SCENARIOS } = require("@/lib/words/phrases") as { SCENARIOS: readonly string[] };
  for (const base of ["words", "alphabets"]) {
    const index = require(`../public/${base}/index.json`) as {
      lists: (AddMeta & { level: string; coverage?: number })[];
    };
    const tree = buildAddTree(index.lists, SCENARIOS);
    const langs = [...new Set(index.lists.map((c) => c.lang))];
    test(`${base}: one node per language, each list exactly once`, () => {
      expect(tree.map((n) => (n.kind === "lang" ? n.lang : "?"))).toEqual(langs);
      expect(
        tree
          .flatMap(leavesOf)
          .map((m) => m.id)
          .sort(),
      ).toEqual(index.lists.map((c) => c.id).sort());
    });
    for (const lang of tree) {
      if (lang.kind !== "lang") continue;
      const own = index.lists.filter((c) => c.lang === lang.lang).map((c) => c.id);
      test(`${base} ${lang.lang}: Add all takes every list of the language`, () => {
        expect([...toggleTick(lang, none, none)].sort()).toEqual([...own].sort());
      });
      const freq = freqListsOf(lang);
      const hasData = freq.length > 0 && freq.every((c) => typeof c.coverage === "number");
      test(`${base} ${lang.lang}: coverage bands ${hasData ? "from its frequency lists" : "none (no frequency data)"}`, () => {
        const bands = coverageBands(freq);
        if (!hasData) return expect(bands).toEqual([]);
        expect(bands.length).toBeGreaterThan(0);
        for (const b of bands) {
          expect(b.ids).toEqual(freq.slice(0, b.ids.length).map((c) => c.id));
          expect(b.coverage).toBeGreaterThanOrEqual(0.5);
        }
      });
      if (hasData)
        test(`${base} ${lang.lang}: coverage grows list by list, and the last list reaches a line`, () => {
          const cov = freq.map((c) => c.coverage!);
          expect(cov).toEqual([...cov].sort((x, y) => x - y));
          expect(cov.at(-1)!).toBeLessThanOrEqual(1);
          // lists beyond the 3000 words every language had are there for a band only
          if (freq.length > 6) {
            const lines = COVERAGE_TARGETS.filter((t) => cov.at(-1)! >= t);
            expect(lines.length).toBeGreaterThan(0);
            expect(cov.at(-2)!).toBeLessThan(lines.at(-1)!);
          }
        });
    }
  }
});

describe("the shipped bands (data-driven: public/words/index.json)", () => {
  const index = require("../public/words/index.json") as {
    lists: { id: string; lang: string; level: string; coverage?: number }[];
  };
  const freq = (lang: string) =>
    index.lists.filter((l) => l.lang === lang && /-freq-\d+$/.test(l.id));
  test("95% of text is reachable for English, Spanish and Portuguese", () => {
    for (const lang of ["en", "es", "pt"])
      expect(coverageBands(freq(lang)).at(-1)!.coverage).toBeGreaterThanOrEqual(0.95);
  });
  test("90% for French, German, Italian and Russian; Hebrew and Chinese have lists", () => {
    for (const lang of ["fr", "de", "it", "ru"])
      expect(coverageBands(freq(lang)).at(-1)!.coverage).toBeGreaterThanOrEqual(0.9);
    expect(freq("he").length).toBeGreaterThan(0);
    expect(freq("zh").length).toBeGreaterThan(0);
  });
  test("the lists users already have keep their ids", () => {
    for (const lang of ["fr", "es", "de", "en", "ko", "it", "pt", "ru"])
      expect(
        freq(lang)
          .slice(0, 6)
          .map((l) => l.id),
      ).toEqual([1, 2, 3, 4, 5, 6].map((n) => `${lang}-freq-${n}`));
  });
});
