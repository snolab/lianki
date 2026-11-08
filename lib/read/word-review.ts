// Reviewing a range's words from the reader v2 (docs/books-plan.md, "Review a
// range's words"): the selection card's 「复习该段落所有单词」 opens /words' own
// list review over the book, with just the paragraph's words; 「制卡」 makes a
// card for each of them that has none yet.
//
// The rules that must not drift live here, pure, so they are unit-tested:
//
// - which words, and in which order (paraWords, orderWords): the paragraph's
//   distinct counted words, unknown and learning ones first by his
//   familiarity, the known ones after;
// - which still need a card (missingWords): by the word map, the ones it
//   has as new or unrecognised (no card in any list);
// - which card a grade goes to (deckIndex, matchCard): a word that already
//   has a card in ANY of his /words lists in the book's language — matched
//   with the reader's own folds (normalisation + lemma rules, the same
//   lib/read/words.ts foldsOf the marks use) — is graded on THAT card, its
//   FSRS state and schedule kept (owner, 2026-11-03 22:18 JST: "继续用我在单词
//   列表的卡组之前的进度"). Only a word with no card anywhere gets a new card,
//   in the book's own list (source "book:<hash>");
// - several lists holding the word: the card reviewed most recently wins,
//   then the one due soonest, then the list id and term (so the pick never
//   depends on row order).

import type { Lemmas } from "./lemma";
import type { Fam, Sentence } from "./reader-model";
import { foldsOf, termKeys } from "./words";

/** The source of a book's own word list: its content hash. */
/**
 * 制卡 is a batch action, for several words at once: a single new word has no
 * button, its swipe or slider adds it (owner, 2026-11-06).
 */
export const MIN_BATCH = 2;

export const bookListSource = (hash: string) => `book:${hash}`;

/** One of his cards, as the in-place review matches it. */
export interface DeckCard {
  listId: string;
  listName: string;
  term: string;
  reading: string | null;
  /** ISO time of its last review (ts-fsrs `last_review`), or null. */
  lastReview: string | null;
  /** ISO due time. */
  due: string;
}

/** Earlier is better: most recently reviewed, then due soonest, then list id, then term. */
export function cardOrder(a: DeckCard, b: DeckCard): number {
  const la = a.lastReview ? Date.parse(a.lastReview) : -Infinity;
  const lb = b.lastReview ? Date.parse(b.lastReview) : -Infinity;
  if (la !== lb) return lb - la > 0 ? 1 : -1;
  const da = Date.parse(a.due);
  const db = Date.parse(b.due);
  if (da !== db && Number.isFinite(da) && Number.isFinite(db)) return da - db;
  if (a.listId !== b.listId) return a.listId < b.listId ? -1 : 1;
  return a.term < b.term ? -1 : a.term > b.term ? 1 : 0;
}

/** His cards by lookup key (lib/read/words.ts termKeys): the best card per key. */
export function deckIndex(cards: readonly DeckCard[], lang: string): Map<string, DeckCard> {
  const idx = new Map<string, DeckCard>();
  for (const c of cards)
    for (const k of termKeys(c.term, c.reading, lang)) {
      const had = idx.get(k);
      if (!had || cardOrder(c, had) < 0) idx.set(k, c);
    }
  return idx;
}

/** The card a book word is graded on: the best over its folds, or null (no card anywhere). */
export function matchCard(
  word: string,
  lang: string,
  idx: Map<string, DeckCard>,
  lem?: Lemmas | null,
): DeckCard | null {
  let best: DeckCard | null = null;
  for (const f of foldsOf(word, lang, lem)) {
    const c = idx.get(f);
    if (c && (!best || cardOrder(c, best) < 0)) best = c;
  }
  return best;
}

/**
 * The term a new card is made under: the client's suggestion (a catalog
 * headword, "regarder" for "regarda") when it is one of the word's folds,
 * otherwise the book's word itself.
 */
export function newCardTerm(
  word: string,
  lang: string,
  suggested: string | null | undefined,
  lem?: Lemmas | null,
): string {
  const s = suggested?.trim();
  if (!s || s.length > 200) return word;
  const folds = new Set(foldsOf(word, lang, lem));
  return termKeys(s, null, lang).some((k) => folds.has(k)) ? s : word;
}

// ── The sheet's words ───────────────────────────────────────────────────

/** One distinct word of the paragraph. */
export interface ParaWord {
  /** Its normalised form (the word map's key). */
  w: string;
  /** As the book spells it, at its first occurrence. */
  text: string;
  /** Its first occurrence's token index in the paragraph. */
  t: number;
  /** The sentence it first occurs in (index in the paragraph). */
  s: number;
  fam: Fam | undefined;
}

/** The paragraph's distinct counted words, in reading order. */
export function paraWords(
  sentences: readonly Sentence[],
  fam: Map<string, Fam> | null,
): ParaWord[] {
  const seen = new Set<string>();
  const out: ParaWord[] = [];
  sentences.forEach((st, s) => {
    for (const g of st.segs) {
      if (!g.w || g.t < 0 || seen.has(g.w)) continue;
      seen.add(g.w);
      out.push({ w: g.w, text: g.text, t: g.t, s, fam: fam?.get(g.w) });
    }
  });
  return out;
}

/** Unrecognised, new, then learning weakest first; off the map counts as new. */
const RANK: Record<Fam, number> = { u: 0, n: 1, l1: 2, l2: 3, l3: 4, k: 5 };

/** Needs review: not known (a word the map has not placed yet counts as needing it). */
export const needsReview = (f: Fam | undefined) => f !== "k";

/**
 * The sheet's order: the words he does not know yet first (unrecognised,
 * new, learning weakest first), each band in reading order; then the known
 * ones, in reading order (shown collapsed).
 */
export function orderWords(words: readonly ParaWord[]): { first: ParaWord[]; rest: ParaWord[] } {
  const rank = (f: Fam | undefined) => (f ? RANK[f] : RANK.n);
  const keyed = words.map((w, i) => ({ w, i, r: rank(w.fam) }));
  keyed.sort((a, b) => a.r - b.r || a.i - b.i);
  const first: ParaWord[] = [];
  const rest: ParaWord[] = [];
  for (const k of keyed) (needsReview(k.w.fam) ? first : rest).push(k.w);
  return { first, rest };
}

/** Words of the range with no card in any of his lists, by the word map (new or unrecognised). */
export const missingWords = (words: readonly ParaWord[]) =>
  words.filter((w) => w.fam === "n" || w.fam === "u");

/** One paragraph's share of a range: its sentences, and its tokens from `from` to `to` (null: start / end). */
export interface SpanPart {
  ss: readonly Sentence[];
  from: number | null;
  to: number | null;
}

/**
 * A hand-made range's distinct counted words, in reading order, across its
 * paragraphs (reader-select.ts "Manual selection"). `sentences` is every
 * sentence of the parts, flat, so a word's `s` names the sentence it first
 * occurs in there (its example); `t` stays the token in its own paragraph.
 */
export function spanWords(
  parts: readonly SpanPart[],
  fam: Map<string, Fam> | null,
): { sentences: Sentence[]; words: ParaWord[] } {
  const seen = new Set<string>();
  const sentences: Sentence[] = [];
  const words: ParaWord[] = [];
  for (const p of parts) {
    const lo = p.from ?? 0;
    const hi = p.to ?? Infinity;
    for (const st of p.ss) {
      const s = sentences.length;
      let used = false;
      for (const g of st.segs) {
        if (!g.w || g.t < lo || g.t > hi || seen.has(g.w)) continue;
        seen.add(g.w);
        used = true;
        words.push({ w: g.w, text: g.text, t: g.t, s, fam: fam?.get(g.w) });
      }
      if (used) sentences.push(st);
    }
  }
  return { sentences, words };
}
