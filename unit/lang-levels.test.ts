// Language levels on the preferred-language list (lib/lang-levels.ts; owner,
// 2026-11-15): the one table, the old plain-tag shape read and written as
// before, the level lookup, the explanation language, the prompt line, and
// the synced key's schema.
import { describe, expect, test } from "bun:test";
import {
  encodeItems,
  explainIn,
  isLangLevel,
  knowsWell,
  LANG_LEVEL_IDS,
  LANG_LEVELS,
  langLevelOf,
  levelCode,
  levelRank,
  levelsLine,
  normalizeItems,
  parseStoredItems,
  STORED_LEVEL_IDS,
  type PrefLang,
} from "@/lib/lang-levels";
import { normalizePreferred, parseStored } from "@/lib/lang-order";
import { PREF_SCHEMAS } from "@/lib/prefs/schema";
import dict from "@/app/components/preferred-langs.content";

const check = (v: unknown) => {
  const r = PREF_SCHEMAS["lang.preferred"].safeParse(v);
  return r.success ? r.data : undefined;
};

describe("the level table", () => {
  test("native, fluent, CEFR C2…A1, unset; best first, ranks strictly falling", () => {
    expect([...LANG_LEVEL_IDS]).toEqual([
      "native",
      "fluent",
      "c2",
      "c1",
      "b2",
      "b1",
      "a2",
      "a1",
      "unset",
    ]);
    const ranks = LANG_LEVELS.map((l) => l.rank);
    for (let i = 1; i < ranks.length; i++) expect(ranks[i]).toBeLessThan(ranks[i - 1]);
    expect([...STORED_LEVEL_IDS]).not.toContain("unset");
    expect(STORED_LEVEL_IDS).toHaveLength(LANG_LEVEL_IDS.length - 1);
  });

  test("every translated label exists in the dictionary; CEFR is its own code", () => {
    const keys = Object.keys(dict.content);
    for (const l of LANG_LEVELS) if (l.label) expect(keys).toContain(l.label);
    expect(levelCode("b2")).toBe("B2");
    expect(levelCode("native")).toBe("native");
  });

  test("ranks and 'knows well'", () => {
    expect(isLangLevel("c1")).toBe(true);
    expect(isLangLevel("C1")).toBe(false);
    expect(isLangLevel(3)).toBe(false);
    expect(levelRank("native")).toBeGreaterThan(levelRank("c2"));
    expect(levelRank("nope")).toBe(0);
    expect(knowsWell("native")).toBe(true);
    expect(knowsWell("fluent")).toBe(true);
    expect(knowsWell("c2")).toBe(false);
    expect(knowsWell("unset")).toBe(false);
  });
});

describe("the stored shape", () => {
  test("the old plain-tag array reads as items with no level", () => {
    expect(parseStoredItems('["ja","zh-hant"]')).toEqual([
      { lang: "ja", level: "unset" },
      { lang: "zh-Hant", level: "unset" },
    ]);
    expect(parseStoredItems(null)).toEqual([]);
    expect(parseStoredItems("{bad")).toEqual([]);
    expect(parseStoredItems('{"lang":"ja"}')).toEqual([]);
  });

  test("mixed items: tags and {lang, level}; bad levels are unset, bad items dropped", () => {
    expect(
      normalizeItems([
        "en",
        { lang: "zh", level: "native" },
        { lang: "ja", level: "b1" },
        { lang: "fr", level: "expert" },
        { lang: 3, level: "c1" },
        null,
        "ja",
      ]),
    ).toEqual([
      { lang: "en", level: "unset" },
      { lang: "zh", level: "native" },
      { lang: "ja", level: "b1" },
      { lang: "fr", level: "unset" },
    ]);
  });

  test("lib/lang-order.ts reads the new shape as its tags (pages that only order keep working)", () => {
    expect(normalizePreferred(["en", { lang: "zh-hans", level: "native" }, { x: 1 }])).toEqual([
      "en",
      "zh-Hans",
    ]);
    expect(parseStored('[{"lang":"ja","level":"a2"},"en"]')).toEqual(["ja", "en"]);
  });

  test("a list without levels is written exactly in the old shape", () => {
    const items: PrefLang[] = [
      { lang: "ja", level: "unset" },
      { lang: "en", level: "unset" },
    ];
    expect(encodeItems(items)).toEqual(["ja", "en"]);
    expect(
      encodeItems([
        { lang: "zh", level: "native" },
        { lang: "ja", level: "unset" },
      ]),
    ).toEqual([{ lang: "zh", level: "native" }, "ja"]);
  });

  test("the synced key takes both shapes and nothing else", () => {
    expect(check(["ja", "zh-Hans"])).toEqual(["ja", "zh-Hans"]);
    expect(check([{ lang: "zh", level: "native" }, "ja"])).toEqual([
      { lang: "zh", level: "native" },
      "ja",
    ]);
    expect(check([{ lang: "zh", level: "unset" }])).toBeUndefined();
    expect(check([{ lang: "zh", level: "expert" }])).toBeUndefined();
    expect(check([{ lang: "https://x.ts.net", level: "c1" }])).toBeUndefined();
    expect(check([{ lang: "zh", level: "c1", note: "x" }])).toBeUndefined();
    expect(check(encodeItems(normalizeItems([{ lang: "fr", level: "a1" }])))).toEqual([
      { lang: "fr", level: "a1" },
    ]);
  });
});

describe("lookups", () => {
  const items: PrefLang[] = [
    { lang: "zh-Hans", level: "native" },
    { lang: "en", level: "c1" },
    { lang: "ja", level: "a2" },
    { lang: "fr", level: "unset" },
  ];

  test("langLevelOf: exact, then same base language, else unset", () => {
    expect(langLevelOf(items, "en")).toBe("c1");
    expect(langLevelOf(items, "en-GB")).toBe("c1");
    expect(langLevelOf(items, "zh")).toBe("native");
    expect(langLevelOf(items, "fr")).toBe("unset");
    expect(langLevelOf(items, "de")).toBe("unset");
    expect(langLevelOf(null, "de")).toBe("unset");
    expect(langLevelOf([{ lang: "ja", level: "unset" }], "ja")).toBe("unset");
  });

  test("explainIn: no levels set = the app's language, unchanged", () => {
    const plain: PrefLang[] = [
      { lang: "ja", level: "unset" },
      { lang: "en", level: "unset" },
    ];
    expect(explainIn(plain, "en", "ja")).toBe("en");
    expect(explainIn(null, "en", "ja")).toBe("en");
    expect(explainIn([], "ja", "ja")).toBe("ja");
  });

  test("explainIn: a native language beats an app language being learnt", () => {
    expect(explainIn(items, "en", "ja")).toBe("zh-Hans");
    expect(explainIn(items, "ja", "fr")).toBe("zh-Hans");
  });

  test("explainIn: an app language known well stays, unless it is the source", () => {
    const own: PrefLang[] = [
      { lang: "en", level: "fluent" },
      { lang: "zh", level: "native" },
    ];
    expect(explainIn(own, "en", "ja")).toBe("en");
    expect(explainIn(own, "en", "en-US")).toBe("zh");
    expect(explainIn(own, "zh", "zh-Hans")).toBe("en");
    expect(explainIn([{ lang: "de", level: "fluent" }], "fr", undefined)).toBe("de");
    expect(explainIn([{ lang: "de", level: "native" }], "de", "de")).toBe("de");
  });

  test("levelsLine: one line, CEFR in capitals, unset without a level", () => {
    expect(levelsLine(items)).toBe("zh-Hans native; en C1; ja A2; fr");
    expect(levelsLine([])).toBe("");
  });
});
