import { describe, expect, test } from "bun:test";
import {
  baseLang,
  canonicalLang,
  defaultPreferred,
  langMatch,
  normalizePreferred,
  orderByPreferred,
  parseStored,
  PREFERRED_LANGS_MAX,
} from "@/lib/lang-order";
import { checkPref } from "@/lib/prefs/schema";

const id = (s: string) => s;

describe("matching (BCP 47 base language)", () => {
  test("canonical forms", () => {
    expect(canonicalLang("zh-hans")).toBe("zh-Hans");
    expect(canonicalLang("pt_BR")).toBe("pt-BR");
    expect(canonicalLang("iw")).toBe("he");
    expect(canonicalLang("")).toBeNull();
    expect(canonicalLang("not a tag")).toBeNull();
    expect(canonicalLang("mul")).toBeNull();
    expect(canonicalLang("und")).toBeNull();
  });
  test("base language", () => {
    expect(baseLang("zh-Hans-CN")).toBe("zh");
    expect(baseLang("EN-us")).toBe("en");
    expect(baseLang("??")).toBe("");
  });
  test("exact, base and none", () => {
    expect(langMatch("zh-Hans", "zh-Hans")).toBe(2);
    expect(langMatch("zh-hans", "zh-Hans")).toBe(2);
    expect(langMatch("zh-Hans", "zh")).toBe(1);
    expect(langMatch("zh", "zh-Hant")).toBe(1);
    expect(langMatch("iw", "he")).toBe(2);
    expect(langMatch("en", "ja")).toBe(0);
    expect(langMatch("en", "mul")).toBe(0);
    expect(langMatch("", "en")).toBe(0);
  });
});

describe("orderByPreferred", () => {
  const items = ["ar", "de", "en", "es", "fr", "ja", "ko", "zh"];

  test("no preferences: the order stays", () => {
    expect(orderByPreferred(items, id, [])).toEqual(items);
    expect(orderByPreferred(items, id, null)).toEqual(items);
  });

  test("preferred first, in the user's order; the rest as they came", () => {
    expect(orderByPreferred(items, id, ["ja", "fr"])).toEqual([
      "ja",
      "fr",
      "ar",
      "de",
      "en",
      "es",
      "ko",
      "zh",
    ]);
  });

  test("a regional or script tag matches its base language", () => {
    expect(orderByPreferred(items, id, ["zh-Hans-CN", "en-GB"]).slice(0, 2)).toEqual(["zh", "en"]);
    expect(orderByPreferred(["en", "zh-Hant", "zh-Hans"], id, ["zh"])).toEqual([
      "zh-Hant",
      "zh-Hans",
      "en",
    ]);
  });

  test("an exact match comes before a base-only one of the same pick", () => {
    expect(orderByPreferred(["en", "zh-Hant", "zh-Hans"], id, ["zh-Hans"])).toEqual([
      "zh-Hans",
      "zh-Hant",
      "en",
    ]);
  });

  test("an earlier pick wins over a later exact one", () => {
    expect(orderByPreferred(["en-US", "fr"], id, ["fr", "en-US"])).toEqual(["fr", "en-US"]);
  });

  test("stable for items of one language; objects and unknown languages", () => {
    const books = [
      { t: "a", lang: "en" },
      { t: "b", lang: "fr" },
      { t: "c", lang: "en" },
      { t: "d", lang: "mul" },
      { t: "e", lang: "" },
    ];
    expect(orderByPreferred(books, (b) => b.lang, ["en"]).map((b) => b.t)).toEqual([
      "a",
      "c",
      "b",
      "d",
      "e",
    ]);
  });

  test("does not change its input", () => {
    const copy = [...items];
    orderByPreferred(items, id, ["zh"]);
    expect(items).toEqual(copy);
  });
});

describe("the list", () => {
  test("normalize: canonical, no duplicates, capped, junk dropped", () => {
    expect(normalizePreferred(["zh-hans", "zh-Hans", "ja", 3, "x://y", "iw"])).toEqual([
      "zh-Hans",
      "ja",
      "he",
    ]);
    const many = Array.from({ length: 40 }, (_, i) => `en-${String(100 + i)}`);
    expect(normalizePreferred(many).length).toBe(PREFERRED_LANGS_MAX);
  });

  test("automatic: studied, then the app's, then the browser's, one per language", () => {
    expect(
      defaultPreferred({ learning: ["ja"], ui: "zh", browser: ["en-US", "en", "zh-CN", "fr"] }),
    ).toEqual(["ja", "zh", "en-US", "fr"]);
    expect(defaultPreferred({})).toEqual([]);
  });

  test("stored copy parses to a clean list", () => {
    expect(parseStored(null)).toEqual([]);
    expect(parseStored("nope")).toEqual([]);
    expect(parseStored('["ja","ja","zh-hant"]')).toEqual(["ja", "zh-Hant"]);
  });

  test("the synced key takes tags only", () => {
    expect(checkPref("lang.preferred", ["ja", "zh-Hans"])).toEqual(["ja", "zh-Hans"]);
    expect(checkPref("lang.preferred", [])).toEqual([]);
    expect(checkPref("lang.preferred", ["https://x.ts.net"])).toBeUndefined();
    expect(checkPref("lang.preferred", ["a/b"])).toBeUndefined();
    expect(
      checkPref(
        "lang.preferred",
        Array.from({ length: PREFERRED_LANGS_MAX + 1 }, () => "en"),
      ),
    ).toBeUndefined();
  });
});
