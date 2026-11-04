// A book word's meaning, for the in-place word review and 制卡 (docs/books-plan.md,
// "Review a range's words"). Owner, 2026-11-04 14:41 JST, Le Petit Prince:
// "有好几个词只有例句没有解释，希望能补上" — then "用AI自动补上".
//
// Where a meaning comes from, first hit wins:
//
// 1. our decks (public/words/*.json), over the word's folds WITH the book's
//    lemmas: "représentait" → représenter, "avalait" → avaler. The device
//    used to look the decks up without the lemmas, so an inflected form had
//    no meaning;
// 2. the generated glosses (D1 word_gloss), shared by everyone;
// 3. the model, for what neither has ("fauve", "boa"): written to word_gloss,
//    so the same word is never generated again.
//
// The rules are pure and here; the I/O is lib/read/gloss-server.ts. Nothing is
// per language: folds and lemmas are the language's data (lib/read/lang).

import type { Lemmas } from "./lemma";
import { foldsOf } from "./words";

/** A deck word, as glossing reads it. */
export interface GlossEntry {
  term: string;
  reading?: string | null;
  back: string;
}

/** The first meaning over a word's folds (lib/read/words.ts foldsOf, lemmas included). */
export function lookupGloss(
  w: string,
  lang: string,
  lem: Lemmas | null | undefined,
  index: ReadonlyMap<string, GlossEntry>,
): GlossEntry | null {
  for (const f of foldsOf(w, lang, lem)) {
    const e = index.get(f);
    if (e) return e;
  }
  return null;
}

/**
 * The headword a meaning is generated and cached under: the dictionary's
 * headword when the lemma file knows the form ("appelait" → appeler), else
 * the word as the book has it.
 */
export function headOf(w: string, lem: Lemmas | null | undefined): string {
  if (!lem || lem.has(w)) return w;
  return lem.of(w)[0] ?? w;
}

/**
 * The prompt for a batch of words. The decks' glosses are English
 * Wiktionary's — short senses separated by "; " — so a generated one reads
 * the same on the slip.
 */
export function glossMessages(lang: string, words: readonly { term: string; ex: string | null }[]) {
  const list = words.map((x) => ({ word: x.term, example: x.ex ?? undefined }));
  return [
    {
      role: "system" as const,
      content:
        `You write dictionary glosses for words of the language with code "${lang}". ` +
        "For each word, give its common meanings in English in the style of a Wiktionary gloss: " +
        'short senses, most common first, separated by "; " (for example "snake" or ' +
        '"to swallow; to believe"). Use the example sentence only to put the sense it uses first. ' +
        "Answer with one JSON object mapping each word exactly as given to its gloss, nothing else.",
    },
    { role: "user" as const, content: JSON.stringify(list) },
  ];
}

/** The longest gloss kept (the card's back is capped at 1,000 characters elsewhere too). */
const MAX_BACK = 1000;

/** The model's answer → gloss per asked term; anything unreadable or unasked is dropped. */
export function parseGlosses(text: string, asked: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const body = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  let obj: unknown;
  try {
    obj = JSON.parse(body);
  } catch {
    return out;
  }
  if (!obj || typeof obj !== "object") return out;
  const want = new Set(asked);
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (!want.has(k) || typeof v !== "string") continue;
    const back = v.replace(/\s+/g, " ").trim().slice(0, MAX_BACK);
    if (back) out.set(k, back);
  }
  return out;
}
