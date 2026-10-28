#!/usr/bin/env bun
/**
 * Every clip the word lists can ask the server for, one JSON line each:
 * `{ lang, text, key, kanji? }`. `text` is exactly what the client sends
 * (spokenText for both the word lists and the alphabets, plus examples), and
 * `key` the R2 object it is looked up under. For a Japanese kana reading,
 * `kanji` is the written word: the engine pitch-accents a word it can see far
 * better than bare kana (はし: 箸 or 橋).
 *
 *   bun scripts/voice/texts.ts > texts.jsonl
 */
import { readdirSync, readFileSync } from "fs";
import { spokenText } from "@/lib/words/spoken";
import { voiceKey } from "@/lib/voice";

type Entry = { term: string; back: string; reading?: string; ex?: string };
type Catalog = { lang: string; entries?: Entry[] };

const seen = new Map<string, { lang: string; text: string; key: string; kanji?: string }>();
const add = (lang: string, text: string, kanji?: string) => {
  text = text.trim();
  if (!text || text.length > 200) return;
  const id = `${lang}\n${text}`;
  const prev = seen.get(id);
  // Lists run most frequent first: the first word to claim a reading keeps it.
  if (prev) return void (prev.kanji ??= kanji);
  seen.set(id, { lang, text, key: voiceKey(lang, text), kanji });
};

for (const [dir, readingOnBack] of [
  ["public/words", true],
  ["public/alphabets", false],
] as const) {
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "index.json")) {
    const cat = JSON.parse(readFileSync(`${dir}/${file}`, "utf8")) as Catalog;
    for (const it of cat.entries ?? []) {
      const said = spokenText(it, cat.lang, readingOnBack);
      const term = it.term.trim();
      const kanji =
        cat.lang === "ja" && said !== term && /\p{Script=Han}/u.test(term) ? term : undefined;
      add(cat.lang, said, kanji);
      if (it.ex) add(cat.lang, it.ex);
    }
  }
}
for (const v of seen.values()) console.log(JSON.stringify(v));
