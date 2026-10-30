import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import config from "@/intlayer.config";
import words from "@/app/(app)/words/page.content";
import wordsImport from "@/app/(app)/words/import/page.content";
import partner from "@/app/components/learning-partner.content";

// /words's Settings sheet once showed one French item among English ones (the
// owner's phone is set to French): every string came from words-page but the
// rest were hardcoded. These keep each string present in every locale, and
// the component free of hardcoded labels.

const locales = config.internationalization!.locales! as string[];
type Node = { nodeType?: string; translation?: Record<string, string> };

/** Strings that read the same in English and that language, on purpose. */
const SAME_AS_EN = new Set([
  "experimental:es",
  "experimental:pt",
  "offline:pt",
  "offline:de",
  "notes:fr", // "{n} notes" is French too
]);

describe.each([
  ["words-page", words.content],
  ["words-import", wordsImport.content],
  ["learning-partner", partner.content],
])("%s", (_name, content) => {
  const entries = Object.entries(content as Record<string, Node>).filter(
    ([, v]) => v?.nodeType === "translation",
  );

  it("has every key in every locale", () => {
    const missing = entries.flatMap(([k, v]) =>
      locales.filter((l) => !v.translation?.[l]?.trim()).map((l) => `${k}:${l}`),
    );
    expect(missing).toEqual([]);
  });

  it("keeps each key's {placeholders} in every locale", () => {
    const ph = (s: string) => [...new Set(s.match(/\{\w+\}/g) ?? [])].sort().join();
    const off = entries.flatMap(([k, v]) =>
      locales
        .filter((l) => ph(v.translation![l]) !== ph(v.translation!.en))
        .map((l) => `${k}:${l}`),
    );
    expect(off).toEqual([]);
  });

  it("translates French and Chinese rather than repeating the English", () => {
    const same = entries.flatMap(([k, v]) =>
      ["fr", "zh"]
        .filter((l) => /[a-z]{3}/i.test(v.translation!.en))
        .filter((l) => v.translation![l] === v.translation!.en && !SAME_AS_EN.has(`${k}:${l}`))
        .map((l) => `${k}:${l}`),
    );
    expect(same).toEqual([]);
  });
});

describe("WordsClient", () => {
  const src = readFileSync(new URL("../app/(app)/words/WordsClient.tsx", import.meta.url), "utf8");

  it("takes labels, hints and titles from words-page, not string literals", () => {
    const literals = [...src.matchAll(/\b(label|hint|title|aria-label|placeholder)="([^"]*)"/g)]
      .filter(([, , v]) => /[A-Za-z]{2}/.test(v))
      .map(([m]) => m);
    expect(literals).toEqual([]);
  });
});
