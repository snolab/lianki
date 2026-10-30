/**
 * /words is translated: every string of app/(app)/words/page.content.ts has
 * all 16 locales with the same placeholders, and the Chinese, Japanese and
 * Korean pages carry no leftover English (the strings once reported still in
 * English on the zh page). Also the CJK wordmark (lib/brand.ts).
 */
import { expect, test } from "bun:test";
import wordsPage from "@/app/(app)/words/page.content";
import config from "@/intlayer.config";
import { BRAND_DOMAIN, cjkWordmark } from "@/lib/brand";

const LOCALES = config.internationalization!.locales! as string[];
type Entry = { translation: Record<string, string> };
const entries = Object.entries(wordsPage.content as unknown as Record<string, Entry>);
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test("every /words string has all 16 locales, with en's placeholders", () => {
  expect(LOCALES.length).toBe(16);
  for (const [key, { translation }] of entries)
    for (const l of LOCALES) {
      const v = translation[l];
      expect(typeof v === "string" && v.trim().length > 0, `${key}.${l}`).toBe(true);
      expect(placeholders(v), `${key}.${l}`).toEqual(placeholders(translation.en));
    }
});

/** What was reported in English on /words?lang=zh. */
const REPORTED = [
  "All word lists",
  "Word lists",
  "An endless list",
  "grade each word",
  "Download for offline",
  " due",
  " learning",
  " mastered",
  " seen",
  " done",
  " new",
  "tap =",
  "hold =",
  "swipe",
  "a little",
  "undo",
  "Again",
  "Hard",
  "Good",
  "Easy",
];
/** Latin that belongs in a CJK string: names, key caps, language codes. */
const ALLOWED = /\b(Lianki|FSRS|Anki|iPhone|Space|Enter|Esc|en|es|fr|de|it|pt|ru|zh|ja|ko|min)\b/g;

test.each(["zh", "ja", "ko"])("/words in %s has no English left", (l) => {
  for (const [key, { translation }] of entries) {
    const v = translation[l];
    for (const phrase of REPORTED)
      expect(v.includes(phrase), `${key}.${l}: "${phrase}"`).toBe(false);
    const latin = v.replace(/\{\w+\}/g, "").replace(ALLOWED, "");
    expect(latin.match(/[A-Za-z]{3,}/)?.[0] ?? null, `${key}.${l}: ${v}`).toBe(null);
  }
});

test("zh wording: 单词列表 / 全部单词列表", () => {
  const zh = Object.fromEntries(entries.map(([k, e]) => [k, e.translation.zh]));
  expect(zh.wordsTitle).toBe("单词列表");
  expect(zh.wordsAll).toBe("全部单词列表");
});

test("the wordmark: 鏈記 (lianki.com) in CJK locales, the localized name elsewhere", () => {
  for (const l of ["zh", "ja", "ko"]) expect(cjkWordmark(l)).toBe("鏈記");
  for (const l of LOCALES.filter((x) => !["zh", "ja", "ko"].includes(x)))
    expect(cjkWordmark(l)).toBe(null);
  expect(BRAND_DOMAIN).toBe("lianki.com");
});
