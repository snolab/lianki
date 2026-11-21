import { describe, expect, test } from "bun:test";
import { langRuns, scriptOfLang, textLang } from "@/lib/words/part-lang";

describe("langRuns: every run in its own language", () => {
  test("an English example with its Chinese translation: two runs, the Chinese one zh", () => {
    expect(langRuns("I like apples. 我喜欢苹果。", "en")).toEqual([
      { text: "I like apples.", lang: "en" },
      { text: "我喜欢苹果。", lang: "zh" },
    ]);
  });

  test("a Japanese UI reads Han-only text as Japanese; kana is Japanese whatever the UI", () => {
    expect(langRuns("I like apples. 林檎", "en", { uiLocale: "ja-JP" })).toEqual([
      { text: "I like apples.", lang: "en" },
      { text: "林檎", lang: "ja" },
    ]);
    expect(langRuns("Good morning. おはようございます。", "en", { uiLocale: "zh" })).toEqual([
      { text: "Good morning.", lang: "en" },
      { text: "おはようございます。", lang: "ja" },
    ]);
  });

  test("a line in one language stays one run", () => {
    expect(langRuns("外は寒い。", "ja")).toEqual([{ text: "外は寒い。", lang: "ja" }]);
    expect(langRuns("Ma maison est grande.", "fr")).toEqual([
      { text: "Ma maison est grande.", lang: "fr" },
    ]);
    expect(langRuns("我喜欢苹果", "zh")).toEqual([{ text: "我喜欢苹果", lang: "zh" }]);
  });

  test("a Chinese card's line: a kana sentence is Japanese, a Han one stays the card's", () => {
    expect(langRuns("今天天气很好。天気がいいです。", "zh")).toEqual([
      { text: "今天天气很好。", lang: "zh" },
      { text: "天気がいいです。", lang: "ja" },
    ]);
    expect(langRuns("天気がいい。", "zh-TW")).toEqual([{ text: "天気がいい。", lang: "ja" }]);
    expect(langRuns("今天天气很好。", "zh-TW")).toEqual([
      { text: "今天天气很好。", lang: "zh-TW" },
    ]);
  });

  test("Latin words inside a non-Latin line stay in it; a Latin sentence is its own run", () => {
    expect(langRuns("我用iPhone打电话。", "zh")).toEqual([
      { text: "我用iPhone打电话。", lang: "zh" },
    ]);
    expect(langRuns("iPhone很贵", "zh")).toEqual([{ text: "iPhone很贵", lang: "zh" }]);
    expect(langRuns("我喜欢苹果。I like apples.", "zh")).toEqual([
      { text: "我喜欢苹果。", lang: "zh" },
      { text: "I like apples.", lang: "en" },
    ]);
    expect(langRuns("我喜欢苹果 (I like apples)", "zh", { latinLang: "fr" })).toEqual([
      { text: "我喜欢苹果 (", lang: "zh" },
      { text: "I like apples)", lang: "fr" },
    ]);
    // Only Latin, nothing to join: read as Latin.
    expect(langRuns("iPhone", "zh")).toEqual([{ text: "iPhone", lang: "en" }]);
  });

  test("other scripts by table: Hangul, Cyrillic, Thai, Greek, Arabic, Hebrew, Devanagari, Bengali", () => {
    const one = (t: string, base = "en") => langRuns(t, base).map((r) => r.lang);
    expect(one("Hello. 안녕하세요")).toEqual(["en", "ko"]);
    expect(one("Hello. Привет")).toEqual(["en", "ru"]);
    expect(one("Привіт", "uk")).toEqual(["uk"]);
    expect(one("สวัสดี")).toEqual(["th"]);
    expect(one("γεια")).toEqual(["el"]);
    expect(one("مرحبا")).toEqual(["ar"]);
    expect(one("שלום")).toEqual(["he"]);
    expect(one("नमस्ते")).toEqual(["hi"]);
    expect(one("নমস্কার")).toEqual(["bn"]);
  });

  test("neutral text: leading punctuation joins the first run; nothing to say is no run", () => {
    expect(langRuns("“Bonjour.” 你好", "fr")).toEqual([
      { text: "“Bonjour.”", lang: "fr" },
      { text: "你好", lang: "zh" },
    ]);
    expect(langRuns("  123 … ", "en")).toEqual([]);
    expect(langRuns("", "en")).toEqual([]);
    expect(langRuns("你好。 ", "zh")).toEqual([{ text: "你好。", lang: "zh" }]);
  });

  test("an English line with Chinese words: the voice never reads another script", () => {
    expect(langRuns("I like 苹果 a lot.", "en")).toEqual([
      { text: "I like", lang: "en" },
      { text: "苹果", lang: "zh" },
      { text: "a lot.", lang: "en" },
    ]);
  });

  test("scriptOfLang and textLang", () => {
    expect(scriptOfLang("ja-JP")).toBe("cjk");
    expect(scriptOfLang("ru_RU")).toBe("cyrillic");
    expect(scriptOfLang("fr")).toBe("latin");
    expect(textLang("house")).toBe("en");
    expect(textLang("house 房子房子")).toBe("zh");
    expect(textLang("家", { uiLocale: "ja" })).toBe("ja");
    expect(textLang("家", { uiLocale: "ko" })).toBe("zh");
    expect(textLang("…")).toBe("en");
    expect(textLang("…", { latinLang: "de" })).toBe("de");
  });
});
