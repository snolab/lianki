// A book's words, counted once at import, and the reader's progress through
// them, counted per request (owner, 2026-11-03 17:01/17:03 JST: "besides the
// line count show the word count and my progress, as if the book were a deck";
// at import, how many words were found, how many already learned, how many
// new, how many unrecognised).
//
// Isomorphic: the server counts at import (and backfills older books); the
// reader's page uses the same functions to tell new words (in one of our word
// lists) from unrecognised ones.
//
// One engine for every language (owner, 19:05 JST: no per-language
// branches): a word is an Intl.Segmenter word segment that is word-like and
// holds a letter, NFKC, lowercased (caseless scripts are unchanged), the
// curly apostrophe read as '. What differs by language is data only, in
// lib/read/lang/<lang>.json: elided clitics stripped (French l', qu'…),
// endings dropped (English 's), ligatures (œ → oe), cheap inflection folds
// (plural -s/-es, -ed, -ing…) tried only when the folded form is itself a card
// or an entry ("chats" finds "chat", "is" never becomes "i"), abbreviations
// that do not end a sentence (Mrs., M.), and whether capitals mark names.
// A language with a lemma file (lib/read/lemma.ts, French first) also maps
// every inflected form to its headword ("regarda" → "regarder") and knows
// which words the dictionary has. Japanese and Chinese depend on the
// segmenter's dictionary (読んで → 読|んで), so their counts are rougher.
//
// Progress uses a /words deck's definition of a learned word (interval a
// year or more, as the deck's "mastered"); see BookProgress for the ring.

import { PROGRESS_SCALE_DAYS, progressPercent, wordScore } from "@/lib/words/progress";
import { langRules, SCRIPT_LANGS, STOP_LANGS } from "./lang";
import { lemmasFromLex, type BookLex, type Lemmas } from "./lemma";

/** Bump when counting changes, so stored stats are counted again. */
export const WORD_STATS_V = 2;

export interface WordStats {
  v: typeof WORD_STATS_V;
  /** The language the words were counted in (primary subtag), or "und". */
  lang: string;
  /** Running words (the coverage denominator; see COVERAGE below). */
  tokens: number;
  /** Distinct words. */
  distinct: number;
  /** Every distinct word with its count, most frequent first. */
  words: [string, number][];
  /** Distinct words taken for proper nouns (names): counted as known. */
  names: string[];
  /**
   * The language's dictionary entries these words need (lib/read/lemma.ts),
   * added on the server once the lemma file is read; absent for languages
   * without one, and until then.
   */
  lex?: BookLex;
}

/*
 * COVERAGE, exactly (owner's pass mark 95%, 2026-11-03 17:10 JST):
 *
 *   coverage = (running words mastered + running words that are names)
 *              ÷ running words
 *
 * Running words: every word-like Intl.Segmenter segment, normalized
 * (normWord), each occurrence counted. Left out entirely: numbers and
 * anything with a digit, punctuation, web addresses and other dotted junk, single letters in alphabetic scripts
 * (a CJK character is a word), and segments with no letter (junk).
 * Names (proper nouns) stay in and count as known, as Hu & Nation (2000) did:
 * a word that the book never writes in lower case and writes capitalised at
 * least once mid-sentence ("Della", "Mrs. Aouda", "l'Angleterre"), not
 * counting words in capitals, the language's notNames (English I'm/I've), or
 * lines that are mostly capitalised (headings, title case). A language whose
 * data says "names": false (German capitalises every noun) gets none, and
 * caseless scripts (ja, zh, ko…) have no capitals, so no names yet.
 * Mastered: the reader has a card for the word (or a fold or lemma of it) whose
 * interval is a year or more, a /words deck's "mastered". Every other word,
 * unrecognised ones included, is unknown and stays in the denominator.
 */

// Scripts in which one character can be a word (Han, kana, Hangul): a
// property of the script, not of a language.
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LETTER = /\p{L}/u;

/** "l'homme" → "homme", "qu'il" → "il", by the language's elisions (lib/read/lang). */
export function stripElision(w: string, lang: string): string {
  const re = langRules(lang).elide;
  return re ? w.replace(re, "") : w;
}

/** The language to count a book in: its own tag's primary subtag, else a guess. */
export function wordLang(tag: string | undefined | null, lines: string[] = []): string {
  const primary = (tag ?? "").trim().toLowerCase().split(/[-_]/)[0];
  if (/^[a-z]{2,3}$/.test(primary) && primary !== "und") return primary;
  const sample = lines.slice(0, 200).join("\n").slice(0, 20_000);
  for (const [lang, re] of SCRIPT_LANGS) if (re.test(sample)) return lang;
  const seen = new Map<string, number>();
  for (const w of sample.toLowerCase().split(/[^\p{L}]+/u))
    if (w) seen.set(w, (seen.get(w) ?? 0) + 1);
  let best = "und";
  let bestN = 0;
  for (const [lang, words] of STOP_LANGS) {
    const n = words.reduce((a, w) => a + (seen.get(w) ?? 0), 0);
    if (n > bestN) [best, bestN] = [lang, n];
  }
  return bestN >= 3 ? best : "und";
}

/** One segment as a counted word, or null when it is not one (numbers, punctuation). */
export function normWord(raw: string, lang: string): string | null {
  let w = raw.normalize("NFKC").replace(/[’ʼ′]/g, "'");
  // Numbers, and junk such as www.gutenberg.org, e-mail and paths.
  if (!LETTER.test(w) || /[\p{N}.@/_:]/u.test(w)) return null;
  // Caseless scripts are left alone by toLowerCase.
  w = w.toLowerCase();
  w = stripElision(w, lang);
  const suffix = langRules(lang).suffix;
  if (suffix) w = w.replace(suffix, "");
  w = w.replace(/^'+|'+$/g, "");
  if (!w || !LETTER.test(w)) return null;
  // A lone letter ("I", "a", "M." of "M. Dupont") is not counted; a CJK character is a word.
  if ([...w].length === 1 && !CJK.test(w)) return null;
  return w;
}

const SENTENCE_END = /[.!?…。！？]/u;

let segCache: { lang: string; seg: Intl.Segmenter } | null = null;
function segmenter(lang: string): Intl.Segmenter {
  if (segCache?.lang !== lang) {
    // wordLang only yields "und" or a 2–3 letter subtag, so this cannot throw.
    const seg = new Intl.Segmenter(lang === "und" ? undefined : lang, { granularity: "word" });
    segCache = { lang, seg };
  }
  return segCache.seg;
}

/** The words of one piece of text, normalized, in order. */
export function wordsOf(text: string, lang: string): string[] {
  const out: string[] = [];
  for (const s of segmentsOf(text, lang)) if (s.word) out.push(s.word);
  return out;
}

/**
 * The text cut into segments that join back into it exactly, each with its
 * counted word (normWord), or null for spaces, punctuation and non-words: for
 * marking words inside a sentence (the /words example's familiarity marks).
 */
export function segmentsOf(text: string, lang: string): { text: string; word: string | null }[] {
  const out: { text: string; word: string | null }[] = [];
  for (const s of segmenter(lang).segment(text))
    out.push({ text: s.segment, word: s.isWordLike ? normWord(s.segment, lang) : null });
  return out;
}

/** Count a book's words (once, at import). */
export function countWords(lines: string[], tag?: string | null): WordStats {
  const lang = wordLang(tag, lines);
  const counts = new Map<string, number>();
  const rules = langRules(lang);
  // Capitals mark names unless the language's file says not (German nouns);
  // a caseless script simply never has a capital.
  const cased = rules.names;
  const notNames = rules.data.notNames ?? [];
  const lower = new Set<string>();
  const capMid = new Set<string>();
  let tokens = 0;
  for (const line of lines) {
    // Each line (paragraph or heading) starts a sentence.
    let start = true;
    const caps: { w: string; cap: boolean; mid: boolean; allCaps: boolean }[] = [];
    let prev = "";
    for (const s of segmenter(lang).segment(line)) {
      if (!s.isWordLike) {
        if (
          SENTENCE_END.test(s.segment) &&
          !(s.segment.startsWith(".") && rules.abbreviations.has(prev))
        )
          start = true;
        if (!/^\s*$/.test(s.segment)) prev = "";
        continue;
      }
      prev = s.segment.toLowerCase();
      const w = normWord(s.segment, lang);
      if (w) {
        tokens++;
        counts.set(w, (counts.get(w) ?? 0) + 1);
        if (cased) {
          // The word's own first letter: "l'Angleterre" is capitalised.
          let raw = s.segment
            .normalize("NFKC")
            .replace(/[’ʼ′]/g, "'")
            .replace(/^'+/, "");
          if (rules.elideAnyCase) raw = raw.replace(rules.elideAnyCase, "");
          const first = raw[0] ?? "";
          caps.push({
            w,
            cap: first !== first.toLowerCase(),
            mid: !start,
            allCaps: raw === raw.toUpperCase(),
          });
        }
      }
      start = false;
    }
    // A title-case or all-caps line (a heading, a licence in capitals) says
    // nothing about names: only its lower-case words count as evidence.
    const capShare = caps.length ? caps.filter((c) => c.cap).length / caps.length : 0;
    const titleLine = caps.length >= 2 && capShare >= 0.6;
    for (const c of caps) {
      if (!c.cap) lower.add(c.w);
      else if (c.mid && !c.allCaps && !titleLine && !notNames.some((p) => c.w.startsWith(p)))
        capMid.add(c.w);
    }
  }
  const words = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const names = [...capMid].filter((w) => !lower.has(w)).sort();
  return { v: WORD_STATS_V, lang, tokens, distinct: words.length, words, names };
}

/** Stored stats, checked; null when missing, malformed or counted by an older rule. */
export function parseWordStats(raw: unknown): WordStats | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Partial<WordStats>;
  if (s.v !== WORD_STATS_V || typeof s.lang !== "string" || !Array.isArray(s.words)) return null;
  const words = s.words.filter(
    (e): e is [string, number] =>
      Array.isArray(e) && typeof e[0] === "string" && Number.isInteger(e[1]) && e[1] > 0,
  );
  const have = new Set(words.map((e) => e[0]));
  const names = Array.isArray(s.names)
    ? s.names.filter((n): n is string => typeof n === "string" && have.has(n))
    : [];
  const lex = lemmasFromLex(s.lex) ? s.lex : undefined;
  return {
    v: WORD_STATS_V,
    lang: s.lang,
    names,
    tokens: words.reduce((a, e) => a + e[1], 0),
    distinct: words.length,
    words,
    ...(lex ? { lex } : {}),
  };
}

/** The dictionary entries stored with a book's words, if any. */
export function statsLemmas(stats: WordStats): Lemmas | null {
  return stats.lex ? lemmasFromLex(stats.lex) : null;
}

/** "cœur" → "coeur": the language's ligatures written out, the key both spellings share. */
export function unligate(w: string, lang: string): string {
  let out = w;
  for (const [lig, plain] of langRules(lang).data.ligatures ?? [])
    if (out.includes(lig)) out = out.split(lig).join(plain);
  return out;
}

/**
 * The forms to try for a book word, itself first: the language's cheap
 * folds (lib/read/lang: plural and verb endings), and, with its dictionary
 * (lib/read/lemma.ts), the headwords the word or a fold is a form of
 * ("regarda" → "regarder", "yeux" → "œil").
 */
export function foldsOf(w: string, lang: string, lem?: Lemmas | null): string[] {
  const out = [w];
  const add = (s: string) => {
    if (s.length >= 2 && !out.includes(s)) out.push(s);
  };
  add(unligate(w, lang));
  // The dictionary, when it knows the word, replaces the guessed endings:
  // "course" is a noun of its own, not "cours" (a form of courir).
  const spelt = out.slice();
  const known = !!lem && spelt.some((f) => lem.has(f) || lem.of(f).length > 0);
  if (!known)
    for (const [end, repl, unless] of langRules(lang).data.folds ?? [])
      if (w.endsWith(end) && !(unless && w.endsWith(unless))) add(w.slice(0, -end.length) + repl);
  if (lem)
    for (const f of known ? spelt : out.slice())
      for (const h of lem.of(f)) {
        add(h);
        add(unligate(h, lang));
      }
  return out;
}

/**
 * The headwords the dictionary says this exact spelling is a form of
 * ("dû" → "devoir", "yeux" → "œil"), no guessed endings: real forms only,
 * accents kept ("du" the article is no form of "devoir"). Empty without one.
 */
export function lemmaHeads(w: string, lang: string, lem: Lemmas | null | undefined): string[] {
  const out: string[] = [];
  if (!lem) return out;
  const add = (s: string) => {
    if (s && s !== w && !out.includes(s)) out.push(s);
  };
  for (const f of new Set([w, unligate(w, lang)]))
    for (const h of lem.of(f)) {
      add(h);
      add(unligate(h, lang));
    }
  return out;
}

/**
 * Each word's headwords (lemmaHeads), two steps deep: a form of a form
 * ("due" → "dû" → "devoir") reaches the headword too. `lemmas` gives the
 * dictionary entries some words need (lemma-server lemmasForWords); only
 * words with a headword are in the answer.
 */
export async function headsOfWords(
  words: readonly string[],
  lang: string,
  lem: Lemmas | null,
  lemmas: (words: string[]) => Promise<Lemmas | null>,
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  if (!lem) return out;
  for (const w of words) {
    const h = lemmaHeads(w, lang, lem);
    if (h.length) out[w] = h;
  }
  const next = [...new Set(Object.values(out).flat())];
  const lem2 = next.length ? await lemmas(next) : null;
  if (lem2)
    for (const [w, hs] of Object.entries(out))
      for (const h of hs.slice())
        for (const g of lemmaHeads(h, lang, lem2)) if (g !== w && !hs.includes(g)) hs.push(g);
  return out;
}

/** One of the reader's word cards, as the progress query returns it. */
export interface CardRow {
  term: string;
  reading?: string | null;
  lang: string;
  /** FSRS stability, days. */
  stability?: number | null;
  /** The current interval (ts-fsrs `scheduled_days`). */
  interval?: number | null;
  /** A year, or the card's list's shorter interval cap (as /words counts it). */
  cap?: number | null;
}

/** What the reader's cards give one word: the deck's score, and whether mastered. */
export interface CardHit {
  /** 0..1, lib/words/progress.ts wordScore: ln(1+stability) against a year. */
  score: number;
  /** Interval at a year or more (or the list's cap): the deck's "mastered". */
  mastered: boolean;
}

/** The keys a card or list entry answers to: its term, and (ja) its reading. */
export function termKeys(term: string, reading: string | null | undefined, lang: string): string[] {
  const keys: string[] = [];
  const add = (s: string | null | undefined) => {
    if (!s) return;
    const k = s
      .normalize("NFKC")
      .replace(/[’ʼ]/g, "'")
      .toLowerCase()
      .trim();
    if (k && !keys.includes(k)) keys.push(k);
  };
  add(term);
  // "être (verb)", "a / an": the head before a gloss or a slash.
  add(term.split(/\s*[(/;,，、]/)[0]);
  // "s'écrier" answers to "écrier", as a book's "s'écria" is read "écria".
  for (const k of keys.slice()) add(stripElision(k, lang));
  for (const k of keys.slice()) add(unligate(k, lang));
  const readingKeys = langRules(lang).reading;
  if (readingKeys && reading && readingKeys.test(reading)) add(reading);
  return keys;
}
/** What one card gives its term: the deck's score, and whether mastered. */
export function cardHit(r: Pick<CardRow, "stability" | "interval" | "cap">): CardHit {
  const cap = r.cap && r.cap > 0 ? r.cap : PROGRESS_SCALE_DAYS;
  return {
    score: wordScore({ stability: r.stability, interval: r.interval }, cap),
    mastered: (r.interval ?? 0) >= Math.min(PROGRESS_SCALE_DAYS, cap),
  };
}

/** The reader's cards as a lookup: key → the best any card gives it. */
export function cardIndex(rows: CardRow[]): Map<string, CardHit> {
  const idx = new Map<string, CardHit>();
  for (const r of rows) {
    const hit = cardHit(r);
    for (const k of termKeys(r.term, r.reading, r.lang)) {
      const had = idx.get(k);
      if (!had) idx.set(k, hit);
      else
        idx.set(k, {
          score: Math.max(had.score, hit.score),
          mastered: had.mastered || hit.mastered,
        });
    }
  }
  return idx;
}

/**
 * A book word's card: its own form or a fold that is a card, combined as
 * cardIndex combines cards — the best score, mastered if any is.
 */
export function hitOf(
  w: string,
  lang: string,
  idx: Map<string, CardHit>,
  lem?: Lemmas | null,
): CardHit | null {
  let best: CardHit | null = null;
  for (const f of foldsOf(w, lang, lem)) {
    const h = idx.get(f);
    if (!h) continue;
    best = best
      ? { score: Math.max(best.score, h.score), mastered: best.mastered || h.mastered }
      : h;
  }
  return best;
}

/** True when the word, or a fold of it, is in `keys` (a word list's terms). */
export function inKeys(w: string, lang: string, keys: Set<string>, lem?: Lemmas | null): boolean {
  return foldsOf(w, lang, lem).some((f) => keys.has(f));
}

/** True when the word, or a fold of it, is a headword of the language's dictionary. */
export function inDict(w: string, lang: string, lem: Lemmas | null | undefined): boolean {
  return !!lem && foldsOf(w, lang, lem).some((f) => lem.has(f));
}

/**
 * The book as a deck. A word is learned the way a /words deck counts a word
 * mastered: its card's interval is a year or more (or its list's shorter
 * cap). The book's ring is coverage: the share of its running words that are
 * learned, each word counted as often as it occurs. It passes at 95% (owner,
 * 17:10 JST: "那就95%作为书籍的及格线"; 17:15 "我们用同样口径统计": the
 * measure of Hu & Nation 2000, see COVERAGE above).
 */
export interface BookProgress {
  /** Running words that are names (counted as known; see COVERAGE). */
  nameTokens: number;
  /** Distinct words with a card. */
  seen: number;
  /** Distinct words whose card is mastered. */
  mastered: number;
  /** Running words with a card. */
  seenTokens: number;
  /** Running words whose card is mastered: the coverage numerator. */
  masteredTokens: number;
}

/** A book passes at this coverage of learned running words. */
export const BOOK_PASS_COVERAGE = 0.95;

export function bookProgress(
  stats: WordStats,
  idx: Map<string, CardHit>,
  lem?: Lemmas | null,
): BookProgress {
  const p: BookProgress = { nameTokens: 0, seen: 0, mastered: 0, seenTokens: 0, masteredTokens: 0 };
  const names = new Set(stats.names);
  for (const [w, n] of stats.words) {
    const h = idx.size ? hitOf(w, stats.lang, idx, lem) : null;
    if (names.has(w) && !h?.mastered) p.nameTokens += n;
    if (!h) continue;
    p.seen++;
    p.seenTokens += n;
    if (h.mastered) {
      p.mastered++;
      p.masteredTokens += n;
    }
  }
  return p;
}

/** Coverage of learned running words, as a whole percentage rounded down. */
export function coveragePercent(p: BookProgress, stats: Pick<WordStats, "tokens">): number {
  return progressPercent(p.masteredTokens + p.nameTokens, stats.tokens) ?? 0;
}

/** Passed: 95% of the running words learned. */
export function bookPassed(p: BookProgress, stats: Pick<WordStats, "tokens">): boolean {
  return (
    stats.tokens > 0 &&
    (p.masteredTokens + p.nameTokens) / stats.tokens >= BOOK_PASS_COVERAGE - 1e-9
  );
}

/** The languages whose cards and lists count for a book in `lang` ("und": all). */
export function langMatches(listLang: string, lang: string): boolean {
  if (lang === "und") return true;
  return listLang.toLowerCase().split(/[-_]/)[0] === lang;
}
