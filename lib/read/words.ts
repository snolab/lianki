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
// Approximation, until the planned extraction (docs/books-plan.md) gives real
// lemmas: a word is its surface form — Intl.Segmenter word segments that are
// word-like and hold a letter, NFKC, lowercased in cased scripts, the curly
// apostrophe read as ', French/Italian elisions (l', d', qu'…) and the
// English possessive 's stripped. Matching a book word to a card or a list
// entry then tries a few cheap inflection folds (plural -s/-es, -ed, -ing, -x)
// only when the folded form is itself a card or an entry, so "chats" finds a
// card for "chat" but "is" never becomes "i". Japanese and Chinese depend on
// the segmenter's dictionary (読んで → 読|んで), so their counts are rougher.
//
// Progress uses a /words deck's definition of a learned word (interval a
// year or more, as the deck's "mastered"); see BookProgress for the ring.

import { PROGRESS_SCALE_DAYS, progressPercent, wordScore } from "@/lib/words/progress";

/** Bump when counting changes, so stored stats are counted again. */
export const WORD_STATS_V = 1;

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
 * in a cased language other than German, a word that the book never writes
 * in lower case and writes capitalised at least once mid-sentence ("Della",
 * "Madame Sofronie"), not counting words in capitals, English I'm/I've, or
 * lines that are mostly capitalised (headings, title case). German capitalises every noun, and caseless scripts
 * (ja, zh, ko…) have no such clue, so they get no names yet.
 * Mastered: the reader has a card for the word (or a fold of it) whose
 * interval is a year or more, a /words deck's "mastered". Every other word,
 * unrecognised ones included, is unknown and stays in the denominator.
 */

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LETTER = /\p{L}/u;
const ELIDE =
  /^(?:l|d|j|m|n|s|t|c|qu|jusqu|lorsqu|puisqu|quoiqu|presqu|dell|dall|nell|sull|all|un|quell|quest|po)'(?=\p{L})/u;

// A handful of function words per Latin-script language, to guess the
// language of pasted text that carries none.
const STOP: Record<string, string[]> = {
  en: ["the", "and", "of", "to", "is", "was", "that", "with", "he", "she", "you"],
  fr: ["le", "la", "les", "et", "est", "une", "dans", "que", "pas", "il", "je", "du"],
  es: ["el", "los", "las", "y", "es", "una", "que", "por", "con", "del", "se", "pero"],
  de: ["der", "die", "und", "das", "ist", "nicht", "ein", "zu", "ich", "mit", "sie"],
  it: ["il", "di", "che", "è", "non", "per", "una", "sono", "gli", "della", "ho"],
  pt: ["o", "os", "as", "que", "não", "uma", "com", "por", "é", "do", "da", "em"],
};

/** The language to count a book in: its own tag's primary subtag, else a guess. */
export function wordLang(tag: string | undefined | null, lines: string[] = []): string {
  const primary = (tag ?? "").trim().toLowerCase().split(/[-_]/)[0];
  if (/^[a-z]{2,3}$/.test(primary) && primary !== "und") return primary;
  const sample = lines.slice(0, 200).join("\n").slice(0, 20_000);
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(sample)) return "ja";
  if (/\p{Script=Hangul}/u.test(sample)) return "ko";
  if (/\p{Script=Han}/u.test(sample)) return "zh";
  if (/\p{Script=Cyrillic}/u.test(sample)) return "ru";
  const seen = new Map<string, number>();
  for (const w of sample.toLowerCase().split(/[^\p{L}]+/u))
    if (w) seen.set(w, (seen.get(w) ?? 0) + 1);
  let best = "und";
  let bestN = 0;
  for (const [lang, words] of Object.entries(STOP)) {
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
  // Cased scripts only; CJK has no case and toLowerCase leaves it alone anyway.
  w = w.toLowerCase();
  if (lang === "fr" || lang === "it" || lang === "ca") w = w.replace(ELIDE, "");
  if (lang === "en") w = w.replace(/'s$/, "");
  w = w.replace(/^'+|'+$/g, "");
  if (!w || !LETTER.test(w)) return null;
  // A lone letter ("I", "a", "M." of "M. Dupont") is not counted; a CJK character is a word.
  if ([...w].length === 1 && !CJK.test(w)) return null;
  return w;
}

/** Languages whose capital letters can mark names. */
function namesByCase(lang: string): boolean {
  return (
    lang !== "de" && lang !== "und" && !["ja", "zh", "ko", "th", "lo", "km", "my"].includes(lang)
  );
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
  for (const s of segmenter(lang).segment(text)) {
    if (!s.isWordLike) continue;
    const w = normWord(s.segment, lang);
    if (w) out.push(w);
  }
  return out;
}

/** Count a book's words (once, at import). */
export function countWords(lines: string[], tag?: string | null): WordStats {
  const lang = wordLang(tag, lines);
  const counts = new Map<string, number>();
  const cased = namesByCase(lang);
  const lower = new Set<string>();
  const capMid = new Set<string>();
  let tokens = 0;
  for (const line of lines) {
    // Each line (paragraph or heading) starts a sentence.
    let start = true;
    const caps: { w: string; cap: boolean; mid: boolean; allCaps: boolean }[] = [];
    for (const s of segmenter(lang).segment(line)) {
      if (!s.isWordLike) {
        if (SENTENCE_END.test(s.segment)) start = true;
        continue;
      }
      const w = normWord(s.segment, lang);
      if (w) {
        tokens++;
        counts.set(w, (counts.get(w) ?? 0) + 1);
        if (cased) {
          const raw = s.segment.normalize("NFKC").replace(/^['’]+/, "");
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
      else if (c.mid && !c.allCaps && !titleLine && !(lang === "en" && c.w.startsWith("i'")))
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
  return {
    v: WORD_STATS_V,
    lang: s.lang,
    names,
    tokens: words.reduce((a, e) => a + e[1], 0),
    distinct: words.length,
    words,
  };
}

/** The forms to try for a book word, itself first; folds are cheap and per language. */
export function foldsOf(w: string, lang: string): string[] {
  const out = [w];
  if (CJK.test(w)) return out;
  const add = (s: string) => {
    if (s.length >= 2 && !out.includes(s)) out.push(s);
  };
  if (lang === "en") {
    if (w.endsWith("ies")) add(w.slice(0, -3) + "y");
    if (w.endsWith("es")) add(w.slice(0, -2));
    if (w.endsWith("s") && !w.endsWith("ss")) add(w.slice(0, -1));
    if (w.endsWith("ied")) add(w.slice(0, -3) + "y");
    if (w.endsWith("ed")) {
      add(w.slice(0, -2));
      add(w.slice(0, -1));
    }
    if (w.endsWith("ing")) {
      add(w.slice(0, -3));
      add(w.slice(0, -3) + "e");
    }
  } else if (lang === "fr" || lang === "es" || lang === "pt" || lang === "it" || lang === "de") {
    if (w.endsWith("es")) add(w.slice(0, -2));
    if (w.endsWith("s") || w.endsWith("x")) add(w.slice(0, -1));
    if (lang === "fr" && w.endsWith("e")) add(w.slice(0, -1));
  }
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
  if (lang === "fr" || lang === "it") add(term.replace(ELIDE, ""));
  if (lang === "ja" && reading && /^[\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u.test(reading))
    add(reading);
  return keys;
}
/** The reader's cards as a lookup: key → the best any card gives it. */
export function cardIndex(rows: CardRow[]): Map<string, CardHit> {
  const idx = new Map<string, CardHit>();
  for (const r of rows) {
    const cap = r.cap && r.cap > 0 ? r.cap : PROGRESS_SCALE_DAYS;
    const hit: CardHit = {
      score: wordScore({ stability: r.stability, interval: r.interval }, cap),
      mastered: (r.interval ?? 0) >= Math.min(PROGRESS_SCALE_DAYS, cap),
    };
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
export function hitOf(w: string, lang: string, idx: Map<string, CardHit>): CardHit | null {
  let best: CardHit | null = null;
  for (const f of foldsOf(w, lang)) {
    const h = idx.get(f);
    if (!h) continue;
    best = best
      ? { score: Math.max(best.score, h.score), mastered: best.mastered || h.mastered }
      : h;
  }
  return best;
}

/** True when the word, or a fold of it, is in `keys` (a word list's terms). */
export function inKeys(w: string, lang: string, keys: Set<string>): boolean {
  return foldsOf(w, lang).some((f) => keys.has(f));
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

export function bookProgress(stats: WordStats, idx: Map<string, CardHit>): BookProgress {
  const p: BookProgress = { nameTokens: 0, seen: 0, mastered: 0, seenTokens: 0, masteredTokens: 0 };
  const names = new Set(stats.names);
  for (const [w, n] of stats.words) {
    const h = idx.size ? hitOf(w, stats.lang, idx) : null;
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
