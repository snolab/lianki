// The selection card's meaning (owner, 2026-11-05 00:35–00:40 JST, /read on
// his phone): when what he selected is a card of his /words decks — a word or
// a phrase ("il y a", "give up", a multi-character expression) — the card's
// meaning shows at once, no tap. Words and phrases are the same cards in the
// same store (/words); there is no reader-only store.
//
// The ladder: word → phrase → whole sentences → whole paragraphs. A selection
// that sits inside a deck phrase resolves to that phrase; one that covers a
// deck phrase (with a ragged edge) shows that phrase's meaning too. The
// longest phrase wins; at equal length his own cards come before the public
// lists. A single word is matched only when it is the whole selection: a
// longer selection always holds some card word, and that is no answer.
//
// One engine for every language: tokens are Intl.Segmenter's word-like
// segments in the book's language (the same cut the book's tokens have), and
// a token matches a phrase word by its loose form or one of its folds
// (lib/read/words.ts foldsOf — the language's data). Pure, so unit-tested.

import type { Fam, Sentence } from "./reader-model";
import { foldsOf, normWord, termKeys } from "./words";
import { wordSegments } from "./word-segments";

/** A deck card's meaning, as the selection card shows it. */
export interface Meaning {
  term: string;
  reading?: string | null;
  back: string;
  /** The /words list his card is in (his own cards only). */
  listId?: string | null;
  /** His card's familiarity, as a word's mark (his own only; an entry with no card is "n"). */
  f?: Exclude<Fam, "u">;
}

/** A multi-word card: its words as the segmenter cuts them, loose forms. */
interface Phrase {
  toks: string[];
  m: Meaning;
}

/** One source of meanings (his cards, a public list), its phrases by first word. */
export interface MeaningIndex {
  /** Single-word cards by lookup key (lib/read/words.ts termKeys). */
  words: Map<string, Meaning>;
  /** Multi-word cards by their first token. */
  phrases: Map<string, Phrase[]>;
  /** The most tokens any phrase has. */
  longest: number;
}

const segs = new Map<string, Intl.Segmenter>();
function wordSegmenter(lang: string): Intl.Segmenter {
  let s = segs.get(lang);
  if (!s) {
    try {
      s = new Intl.Segmenter(lang && lang !== "und" ? lang : undefined, { granularity: "word" });
    } catch {
      s = new Intl.Segmenter(undefined, { granularity: "word" });
    }
    segs.set(lang, s);
  }
  return s;
}

/** A token's loose form: compatibility forms, the curly apostrophe and case folded. */
export function looseTok(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[’ʼ′]/g, "'")
    .toLowerCase()
    .trim();
}

/** A text's word-like tokens, loose forms, in order. */
export function phraseTokens(text: string, lang: string): string[] {
  const out: string[] = [];
  for (const s of wordSegments(wordSegmenter(lang), text))
    if (s.isWordLike) {
      const t = looseTok(s.segment);
      if (t) out.push(t);
    }
  return out;
}

/**
 * A phrase as a card is made and matched under: its text with compatibility
 * forms, the curly apostrophe and case folded, runs of space made one, and
 * no punctuation at its ends ("Il y a," → "il y a").
 */
export function phraseKey(text: string): string {
  return looseTok(text)
    .replace(/\s+/g, " ")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .trim();
}

/** The keys a book token answers to: its loose form, its counted word and that word's folds. */
function tokKeys(text: string, lang: string): string[] {
  const out = [looseTok(text)];
  const w = normWord(text, lang);
  if (w) for (const f of foldsOf(w, lang)) if (!out.includes(f)) out.push(f);
  return out;
}

/** An index over cards: single words by key, phrases (two tokens or more) by first token. */
export function meaningIndex(
  entries: Iterable<Meaning>,
  lang: string,
  /** Book words the server matched through the language's lemmas: word → card. */
  forms?: Iterable<[string, Meaning]>,
): MeaningIndex {
  const idx: MeaningIndex = { words: new Map(), phrases: new Map(), longest: 0 };
  for (const [w, m] of forms ?? []) if (m.back?.trim()) idx.words.set(w, m);
  const seen = new Set<string>();
  for (const m of entries) {
    if (!m.back?.trim()) continue;
    const toks = phraseTokens(m.term, lang);
    if (toks.length >= 2) {
      const sig = toks.join(" ");
      if (seen.has(sig)) continue;
      seen.add(sig);
      const list = idx.phrases.get(toks[0]) ?? [];
      list.push({ toks, m });
      idx.phrases.set(toks[0], list);
      idx.longest = Math.max(idx.longest, toks.length);
    } else
      for (const k of termKeys(m.term, m.reading, lang)) if (!idx.words.has(k)) idx.words.set(k, m);
  }
  return idx;
}

/** The book's tokens of one paragraph, by token index: their text as the book has it. */
export type ParaTokens = readonly string[];

export interface MeaningHit {
  m: Meaning;
  /** The card's tokens in the paragraph, both inclusive. */
  t0: number;
  t1: number;
  /** The selection lies inside the card's words (it IS that word or phrase). */
  inside: boolean;
}

/**
 * The deck card a selection of tokens [t0, t1] of one paragraph is, or
 * covers: the longest phrase around it or within it, else (one token only)
 * that word's card. `indexes` in priority order: his cards first.
 */
export function matchMeaning(
  toks: ParaTokens,
  t0: number,
  t1: number,
  indexes: readonly MeaningIndex[],
  lang: string,
): MeaningHit | null {
  if (t0 < 0 || t1 < t0 || t1 >= toks.length) return null;
  const keys = new Map<number, string[]>();
  const keysAt = (i: number) => {
    let k = keys.get(i);
    if (!k) keys.set(i, (k = tokKeys(toks[i], lang)));
    return k;
  };
  let best: MeaningHit | null = null;
  let bestLen = 0;
  for (const idx of indexes) {
    if (!idx.longest) continue;
    for (let i = Math.max(0, t0 - idx.longest + 1); i <= t1; i++) {
      const cands = new Set<Phrase>();
      for (const k of keysAt(i)) for (const p of idx.phrases.get(k) ?? []) cands.add(p);
      for (const p of cands) {
        const end = i + p.toks.length - 1;
        if (end >= toks.length || p.toks.length <= bestLen) continue;
        const around = i <= t0 && end >= t1;
        const within = i >= t0 && end <= t1;
        if (!around && !within) continue;
        let ok = true;
        for (let j = 1; j < p.toks.length && ok; j++) ok = keysAt(i + j).includes(p.toks[j]);
        if (!ok) continue;
        best = { m: p.m, t0: i, t1: end, inside: around };
        bestLen = p.toks.length;
      }
    }
  }
  if (best || t0 !== t1) return best;
  for (const idx of indexes)
    for (const k of keysAt(t0)) {
      const m = idx.words.get(k);
      if (m) return { m, t0, t1, inside: true };
    }
  return null;
}

/** A paragraph's tokens by token index (the book's text), from its sentences. */
export function paraTokens(sentences: readonly Sentence[]): string[] {
  const toks: string[] = [];
  for (const st of sentences) for (const g of st.segs) if (g.t >= 0) toks[g.t] = g.text;
  return toks;
}

/** A deck phrase found in a paragraph: its tokens, both inclusive, and its card. */
export interface PhraseSpan {
  t0: number;
  t1: number;
  m: Meaning;
}

/**
 * The phrase cards of `idx` in a paragraph's tokens, for the reader's phrase
 * marks and the combo's phrase level (owner, 2026-11-05 00:47 JST): longest
 * first, never overlapping (a shorter card inside or across a longer one's
 * words is left out; at equal length the earlier one wins), in text order.
 * Only cards he made pass — the phrase criterion (docs/books-plan.md): nothing
 * is detected here. Cheap for long books: nothing to do without a phrase card,
 * and each token looks up only the phrases starting with one of its keys.
 */
export function phraseSpans(toks: ParaTokens, idx: MeaningIndex, lang: string): PhraseSpan[] {
  if (!idx.longest || toks.length < 2) return [];
  const keys: (string[] | undefined)[] = [];
  const keysAt = (i: number) => (keys[i] ??= toks[i] ? tokKeys(toks[i], lang) : []);
  const found: PhraseSpan[] = [];
  for (let i = 0; i < toks.length; i++) {
    const cands = new Set<Phrase>();
    for (const k of keysAt(i)) for (const p of idx.phrases.get(k) ?? []) cands.add(p);
    for (const p of cands) {
      const end = i + p.toks.length - 1;
      if (end >= toks.length) continue;
      let ok = true;
      for (let j = 1; j < p.toks.length && ok; j++) ok = keysAt(i + j).includes(p.toks[j]);
      if (ok) found.push({ t0: i, t1: end, m: p.m });
    }
  }
  if (!found.length) return [];
  found.sort((a, b) => b.t1 - b.t0 - (a.t1 - a.t0) || a.t0 - b.t0);
  const taken = new Uint8Array(toks.length);
  const out: PhraseSpan[] = [];
  for (const s of found) {
    let free = true;
    for (let t = s.t0; t <= s.t1 && free; t++) free = !taken[t];
    if (!free) continue;
    taken.fill(1, s.t0, s.t1 + 1);
    out.push(s);
  }
  return out.sort((a, b) => a.t0 - b.t0);
}

/** The phrase span holding token `t`, or null. */
export function phraseAtToken(spans: readonly PhraseSpan[], t: number): PhraseSpan | null {
  for (const s of spans) if (t >= s.t0 && t <= s.t1) return s;
  return null;
}

/** A word's card: the first index whose single words have it or one of its folds. */
export function wordMeaning(
  w: string,
  indexes: readonly MeaningIndex[],
  lang: string,
): Meaning | null {
  for (const idx of indexes)
    for (const k of [looseTok(w), ...foldsOf(w, lang)]) {
      const m = idx.words.get(k);
      if (m) return m;
    }
  return null;
}

/**
 * Whether `w` is a phrase of the book a card can be made under (制卡 on a
 * phrase selection, the same create path as a word's): in its phrase form
 * (phraseKey), two tokens or more, and every counted word of it a word of
 * the book.
 */
export function bookPhrase(w: string, lang: string, has: (word: string) => boolean): boolean {
  if (!w || w !== phraseKey(w)) return false;
  const toks = phraseTokens(w, lang);
  if (toks.length < 2) return false;
  let counted = 0;
  for (const t of toks) {
    const n = normWord(t, lang);
    if (!n) continue;
    if (!has(n)) return false;
    counted++;
  }
  return counted > 0;
}
