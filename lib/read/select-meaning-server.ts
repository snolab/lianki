// His /words cards' meanings for one book (the rules: lib/read/select-meaning.ts):
// the cards and his imported lists' entries in the book's language that the
// book can show — single words matched to the book's words over its lemmas,
// phrases whose words are all in the book. Read once by the reader, so a
// selection's meaning is on the device before he selects anything.
import type { D1Like } from "@/lib/d1/types";
import { headOf } from "./gloss";
import type { Lemmas } from "./lemma";
import { langClause } from "./progress";
import { phraseTokens, type Meaning } from "./select-meaning";
import { foldsOf, normWord, termKeys } from "./words";

export interface BookMeanings {
  cards: Meaning[];
  /** Book words matched to a single-word card through folds or lemmas: [word, index in cards]. */
  forms: [string, number][];
  /**
   * Book words that are an inflected form, with their dictionary headword
   * (the language's lemma file, lib/read/lemma.ts): "représentait" →
   * "représenter". The card shows "form → lemma".
   */
  heads: [string, string][];
}

/** His cards first, then his lists' entries; only those with a meaning. */
async function ownMeanings(db: D1Like, email: string, lang: string): Promise<Meaning[]> {
  const { sql, args } = langClause([lang]);
  const q = (table: "word_cards" | "word_list_entries") =>
    db
      .prepare(
        `SELECT c.term AS term, c.reading AS reading, c.back AS back, c.list_id AS listId
         FROM ${table} c JOIN word_lists l ON l.email = c.email AND l.id = c.list_id
         WHERE c.email = ? AND c.back != ''${sql}`,
      )
      .bind(email, ...args)
      .all<Meaning>();
  const [cards, entries] = await Promise.all([q("word_cards"), q("word_list_entries")]);
  // A list's entry mirrors its card: one meaning per term, the card's first.
  const seen = new Set<string>();
  return [...cards.results, ...entries.results].filter((m) => {
    const k = m.term.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The meanings that can match this book's words, first card first (pure: unit-tested). */
export function bookMeanings(
  all: readonly Meaning[],
  bookWords: readonly string[],
  lang: string,
  lem: Lemmas | null,
): BookMeanings {
  const cards: Meaning[] = [];
  const at = new Map<Meaning, number>();
  const take = (m: Meaning) => {
    let i = at.get(m);
    if (i === undefined) at.set(m, (i = cards.push(m) - 1));
    return i;
  };
  const book = new Set<string>();
  for (const w of bookWords) for (const f of foldsOf(w, lang, lem)) book.add(f);
  const single = new Map<string, Meaning>();
  for (const m of all) {
    if (!m.back?.trim()) continue;
    const toks = phraseTokens(m.term, lang);
    if (toks.length >= 2) {
      // Every counted word of the phrase is somewhere in the book.
      const ok = toks.every((t) => {
        const w = normWord(t, lang);
        return !w || foldsOf(w, lang).some((f) => book.has(f));
      });
      if (ok) take(m);
    } else for (const k of termKeys(m.term, m.reading, lang)) if (!single.has(k)) single.set(k, m);
  }
  const forms: [string, number][] = [];
  for (const w of bookWords)
    for (const f of foldsOf(w, lang, lem)) {
      const m = single.get(f);
      if (!m) continue;
      forms.push([w, take(m)]);
      break;
    }
  const heads: [string, string][] = [];
  for (const w of bookWords) {
    const h = headOf(w, lem);
    if (h !== w) heads.push([w, h]);
  }
  return { cards, forms, heads };
}

export async function readBookMeanings(
  db: D1Like,
  email: string,
  lang: string,
  bookWords: readonly string[],
  lem: Lemmas | null,
): Promise<BookMeanings> {
  return bookMeanings(await ownMeanings(db, email, lang), bookWords, lang, lem);
}
