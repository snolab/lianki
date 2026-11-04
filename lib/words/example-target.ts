/**
 * The card's own word inside its example sentence (owner, 2026-11-04 21:44
 * JST: a long example scrolls so the word is in view, and the word is
 * highlighted there).
 *
 * One engine for every language: what differs is data (lib/read/lang/*.json
 * through normWord and foldsOf). The card's forms (its term, and its reading
 * if any) are matched against the example's words in three tiers, the first
 * that finds anything wins:
 *
 * 1. word by word: a word of the example matches when one of its folds
 *    (foldsOf: elision, ligatures, the language's cheap inflections) equals
 *    one of the form's, case- and diacritic-insensitively; a form of several
 *    words matches the same number of consecutive words;
 * 2. the form as a substring, case- and diacritic-insensitively, for scripts
 *    the segmenter cuts differently from the card (no spaces between words);
 * 3. an inflected form the folds do not know ("mâchait" for "mâcher"): a word
 *    that starts with most of the form; the whole word is highlighted.
 */
import { foldsOf, wordsOf } from "@/lib/read/words";
import { exampleSegments, famLang } from "./example-marks";

/** A stretch of the example, [start, end) in UTF-16 units. */
export type Span = readonly [number, number];

/** Case, compatibility forms, diacritics and the curly apostrophe folded away. */
export function looseKey(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[’ʼ′]/g, "'")
    .toLowerCase();
}

/** The keys a word may be matched by: itself, or with its folds too; each also without diacritics. */
function keysOf(word: string, lang: string, folds: boolean): Set<string> {
  const out = new Set<string>();
  for (const f of folds ? foldsOf(word, lang) : [word]) {
    out.add(f);
    out.add(looseKey(f));
  }
  return out;
}

const meets = (a: Set<string>, b: Set<string>) => {
  for (const k of a) if (b.has(k)) return true;
  return false;
};

type WordSeg = { start: number; end: number; word: string; raw: string };

function wordSegs(text: string, lang: string): WordSeg[] {
  const out: WordSeg[] = [];
  let at = 0;
  for (const s of exampleSegments(text, lang)) {
    const end = at + s.text.length;
    if (s.word) out.push({ start: at, end, word: s.word, raw: s.text });
    at = end;
  }
  return out;
}

/**
 * Tier 1: whole words (and runs of words for a form of several) — the very
 * word first, and only without it its folds ("danse" folds to "dans", so it
 * is the card "dans" only when the example has no "dans" itself).
 */
function byWords(segs: WordSeg[], forms: string[][], lang: string, folds: boolean): Span[] {
  const out: Span[] = [];
  const has = segs.map((s) => keysOf(s.word, lang, folds));
  for (const words of forms) {
    if (!words.length) continue;
    const want = words.map((w) => keysOf(w, lang, folds));
    for (let i = 0; i + want.length <= segs.length; i++)
      if (want.every((k, j) => meets(k, has[i + j])))
        out.push([segs[i].start, segs[i + want.length - 1].end]);
  }
  return out;
}

/**
 * The text folded by looseKey, with where each folded unit came from, so a
 * match in the folded text maps back onto the original.
 */
function looseMap(text: string): { key: string; from: number[] } {
  let key = "";
  const from: number[] = [];
  let at = 0;
  for (const ch of text) {
    const k = looseKey(ch);
    key += k;
    for (let n = 0; n < k.length; n++) from.push(at);
    at += ch.length;
  }
  from.push(at);
  return { key, from };
}

/** Tier 2: the form anywhere in the text. */
function bySubstring(text: string, forms: string[]): Span[] {
  const { key, from } = looseMap(text);
  const out: Span[] = [];
  for (const f of forms) {
    const k = looseKey(f).trim();
    if (!k) continue;
    for (let i = key.indexOf(k); i >= 0; i = key.indexOf(k, i + k.length)) {
      // A match ending inside one character (a ligature folded to two) takes all of it.
      const end = Math.max(from[i + k.length], from[i] + 1);
      out.push([from[i], end]);
    }
  }
  return out;
}

/** Tier 3: a word starting with most of a one-word form (an inflection the folds miss). */
function byStem(segs: WordSeg[], forms: string[]): Span[] {
  const out: Span[] = [];
  for (const f of forms) {
    const chars = [...looseKey(f).trim()];
    if (chars.length < 3 || /\s/.test(f.trim())) continue;
    const stem = chars.slice(0, Math.max(2, Math.ceil((chars.length * 2) / 3))).join("");
    for (const s of segs) if (looseKey(s.raw).startsWith(stem)) out.push([s.start, s.end]);
  }
  return out;
}

/** Sorted, overlaps joined. */
function tidy(spans: Span[]): Span[] {
  const s = [...spans].sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const out: [number, number][] = [];
  for (const [a, b] of s) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

const CAP = 2000;
const cache = new Map<string, Span[]>();

/**
 * Where the card's word stands in its example: every occurrence, in order.
 * `forms` are the card's own spellings (term, reading); empty ones are skipped.
 */
export function targetSpans(
  text: string,
  forms: readonly (string | null | undefined)[],
  lang: string,
): Span[] {
  const fs = [...new Set(forms.map((f) => f?.trim()).filter((f): f is string => !!f))];
  if (!text || !fs.length) return [];
  const k = `${lang}\n${fs.join("\n")}\n${text}`;
  const hit = cache.get(k);
  if (hit) return hit;
  const L = famLang(lang);
  const segs = wordSegs(text, lang);
  const words = fs.map((f) => wordsOf(f, L));
  let spans = byWords(segs, words, L, false);
  if (!spans.length) spans = byWords(segs, words, L, true);
  if (!spans.length) spans = bySubstring(text, fs);
  if (!spans.length) spans = byStem(segs, fs);
  const out = tidy(spans);
  if (cache.size >= CAP) cache.delete(cache.keys().next().value!);
  cache.set(k, out);
  return out;
}

/** One piece of a marked example: its text, its counted word, and whether it is the card's word. */
export type Piece = { text: string; word: string | null; target: boolean };

/**
 * The example cut at its word segments (familiarity marks) and at the target's
 * edges, so the renderer can wrap the target's pieces together.
 */
export function examplePieces(text: string, lang: string, spans: readonly Span[]): Piece[] {
  const segs = exampleSegments(text, lang);
  if (!spans.length) return segs.map((s) => ({ ...s, target: false }));
  const out: Piece[] = [];
  let at = 0;
  for (const s of segs) {
    const end = at + s.text.length;
    // Cut points inside this segment: span edges.
    const cuts = [at];
    for (const [a, b] of spans) {
      if (a > at && a < end) cuts.push(a);
      if (b > at && b < end) cuts.push(b);
    }
    cuts.sort((x, y) => x - y).push(end);
    for (let i = 0; i + 1 < cuts.length; i++) {
      const [a, b] = [cuts[i], cuts[i + 1]];
      if (a === b) continue;
      const target = spans.some(([x, y]) => a >= x && b <= y);
      // A cut word keeps its familiarity only whole.
      out.push({ text: text.slice(a, b), word: cuts.length === 2 ? s.word : null, target });
    }
    at = end;
  }
  return out;
}

/** Pieces grouped into runs: each run is the target's or not, in order. */
export function pieceRuns(pieces: readonly Piece[]): { target: boolean; pieces: Piece[] }[] {
  const out: { target: boolean; pieces: Piece[] }[] = [];
  for (const p of pieces) {
    const last = out.at(-1);
    if (last && last.target === p.target) last.pieces.push(p);
    else out.push({ target: p.target, pieces: [p] });
  }
  return out;
}
