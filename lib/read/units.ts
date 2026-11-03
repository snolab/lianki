// Review units for the reader (docs/books-plan.md, "Review units"): sentences
// with stable ids, paragraphs, and items — runs of whole sentences sized by
// reading time. Pure and isomorphic; the server is the one place that
// segments, so every device sees the same ids.
//
// One engine for every language: Intl.Segmenter plus the language's data file
// (lib/read/lang, `abbreviations`). No per-language branches.

import { langRules } from "./lang";
import type { Granularity, ItemBounds, Paragraph, SentenceRef } from "./reader-api";
import { sentenceId } from "./reader-api";

// ── ids ─────────────────────────────────────────────────────────────────────

const enc = new TextEncoder();

/**
 * The book hash sentence ids start with: SHA-256 over the plain lines joined
 * by newlines, the first 16 hex digits. Lines are plain text (no markup), so
 * emphasis added later keeps the ids.
 */
export async function bookHash(lines: readonly string[]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(lines.join("\n")));
  // Array.from, not a typed array's own map (that would keep bytes, not strings).
  return Array.from(new Uint8Array(digest, 0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A short hash of a sentence's text (FNV-1a, 32 bits): detects a moved cut. */
export function textKey(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// ── segmentation ────────────────────────────────────────────────────────────

const segCache = new Map<string, { sentence: Intl.Segmenter; word: Intl.Segmenter }>();
function segmenters(lang: string) {
  let s = segCache.get(lang);
  if (!s) {
    let loc: string | undefined = lang === "und" ? undefined : lang;
    try {
      new Intl.Segmenter(loc);
    } catch {
      loc = undefined;
    }
    s = {
      sentence: new Intl.Segmenter(loc, { granularity: "sentence" }),
      word: new Intl.Segmenter(loc, { granularity: "word" }),
    };
    segCache.set(lang, s);
  }
  return s;
}

const HAS_CONTENT = /[\p{L}\p{N}]/u;
const TRAILING_WS = /\s+$/u;
const LAST_WORD = /([\p{L}]+)\.$/u;

/**
 * A line's sentences as [start, end) offsets, trailing spaces left out. A cut
 * after one of the language's abbreviations ("Mrs.", "M.") is undone, and a
 * piece with no letter or digit (a lone dash, a closing quote) joins the
 * sentence before it.
 */
export function segmentLine(line: string, lang: string): [number, number][] {
  const out: [number, number][] = [];
  const abbr = langRules(lang).abbreviations;
  let glue = false;
  for (const s of segmenters(lang).sentence.segment(line)) {
    const start = s.index;
    const end = start + s.segment.replace(TRAILING_WS, "").length;
    if (end <= start) continue;
    const text = line.slice(start, end);
    if (out.length && (glue || !HAS_CONTENT.test(text))) out[out.length - 1][1] = end;
    else out.push([start, end]);
    const last = LAST_WORD.exec(line.slice(out[out.length - 1][0], end));
    glue = !!last && abbr.has(last[1].toLowerCase());
  }
  if (!out.length && line.trim()) out.push([0, line.replace(TRAILING_WS, "").length]);
  return out;
}

/** Word-like segments of a piece of text (numbers included): its reading load. */
export function readingLoad(text: string, lang: string): number {
  let n = 0;
  for (const s of segmenters(lang).word.segment(text)) if (s.isWordLike) n++;
  return n;
}

/** Every sentence of a book, flat. */
export interface BookSentences {
  hash: string;
  lang: string;
  /** Sentence count. */
  n: number;
  /** 4 per sentence: line, index, start, end. */
  refs: Int32Array;
  /** Reading load per sentence. */
  load: Int32Array;
  /** First sentence of each line; length = lines + 1. */
  lineStart: Int32Array;
}

export function segmentBook(lines: readonly string[], lang: string, hash: string): BookSentences {
  const refs: number[] = [];
  const load: number[] = [];
  const lineStart = new Int32Array(lines.length + 1);
  for (let l = 0; l < lines.length; l++) {
    lineStart[l] = load.length;
    const parts = segmentLine(lines[l], lang);
    parts.forEach(([a, b], i) => {
      refs.push(l, i, a, b);
      load.push(readingLoad(lines[l].slice(a, b), lang));
    });
  }
  lineStart[lines.length] = load.length;
  return {
    hash,
    lang,
    n: load.length,
    refs: Int32Array.from(refs),
    load: Int32Array.from(load),
    lineStart,
  };
}

export function refOf(b: BookSentences, i: number): SentenceRef {
  return [b.refs[i * 4], b.refs[i * 4 + 1], b.refs[i * 4 + 2], b.refs[i * 4 + 3]];
}

export function sidOf(b: BookSentences, i: number): string {
  return sentenceId(b.hash, b.refs[i * 4], b.refs[i * 4 + 1]);
}

/** The flat index of sentence (line, index), or -1. */
export function sentenceIndex(b: BookSentences, line: number, index: number): number {
  if (line < 0 || line >= b.lineStart.length - 1) return -1;
  const i = b.lineStart[line] + index;
  return index >= 0 && i < b.lineStart[line + 1] ? i : -1;
}

// ── paragraphs and chapters ─────────────────────────────────────────────────

/**
 * Paragraphs from the book's joins: a line in `breaks` continues the paragraph
 * after a visible line break, one in `continues` after a space (a long
 * paragraph split at import). Without joins every line is a paragraph.
 */
export function paragraphsOf(
  lineCount: number,
  joins: { breaks?: readonly number[]; continues?: readonly number[] } = {},
): Paragraph[] {
  const br = new Set(joins.breaks ?? []);
  const cont = new Set(joins.continues ?? []);
  const out: Paragraph[] = [];
  for (let l = 0; l < lineCount; l++) {
    const p = out[out.length - 1];
    if (p && l > 0 && (br.has(l) || cont.has(l))) {
      p.end = l + 1;
      if (br.has(l)) p.breaks.push(l);
    } else out.push({ start: l, end: l + 1, breaks: [] });
  }
  return out;
}

/** Chapter line ranges [start, end) from chapter starts (ascending, first 0). */
export function chapterRanges(lineCount: number, starts: readonly number[]): [number, number][] {
  const s = starts.length && starts[0] === 0 ? starts : [0, ...starts];
  return s.map((a, i) => [a, i + 1 < s.length ? s[i + 1] : lineCount]);
}

// ── time bounds ─────────────────────────────────────────────────────────────

/**
 * Before a user has reads of their own: silent reading at 238 words a minute
 * (Brysbaert 2019, the meta-analysis mean), replaced by their speed.
 */
export const PRIOR_WORDS_PER_SECOND = 238 / 60;
/**
 * Before data, an item takes at least the upper end of the 1–3 s a person
 * takes to react to information (design-principles.md, "No fixed numbers").
 */
export const REACTION_SECONDS = 3;
/** The tails used from a user's reads: their short and long reads before a swipe. */
export const LOW_Q = 0.1;
export const HIGH_Q = 0.9;
/** Reads needed before a LOW_Q quantile exists as its own value: 1 / LOW_Q. */
export const MIN_SAMPLES = Math.ceil(1 / LOW_Q);

/** One graded read: its reading load and how long it was read before the swipe. */
export interface ReadSample {
  words: number;
  dwellMs: number;
}

export function quantile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Item bounds for a user from their own reads in this language: speed = the
 * median words per second, lower = their LOW_Q read before a swipe, upper =
 * their HIGH_Q. Before MIN_SAMPLES reads: the prior speed, REACTION_SECONDS,
 * and no upper bound (the chosen unit unsplit). `seconds` is a span the user
 * picked for g=time.
 */
export function itemBounds(
  samples: readonly ReadSample[],
  granularity: Granularity,
  seconds?: number,
): ItemBounds {
  const ok = samples.filter(
    (s) => s.words > 0 && s.dwellMs > 0 && Number.isFinite(s.dwellMs) && Number.isFinite(s.words),
  );
  const user = ok.length >= MIN_SAMPLES;
  const dwell = ok.map((s) => s.dwellMs / 1000).sort((a, b) => a - b);
  const speeds = ok.map((s) => s.words / (s.dwellMs / 1000)).sort((a, b) => a - b);
  const wps = user ? quantile(speeds, 0.5) : PRIOR_WORDS_PER_SECOND;
  const minSeconds = user ? quantile(dwell, LOW_Q) : REACTION_SECONDS;
  const maxSeconds = user ? Math.max(minSeconds, quantile(dwell, HIGH_Q)) : null;
  const b: ItemBounds = {
    minSeconds,
    maxSeconds,
    wordsPerSecond: wps,
    speedSource: user ? "user" : "prior",
    boundsSource: user ? "user" : "prior",
    samples: ok.length,
  };
  if (granularity === "time") {
    const typical = user ? quantile(dwell, 0.5) : minSeconds;
    let t = seconds && seconds > 0 && Number.isFinite(seconds) ? seconds : typical;
    t = Math.max(t, minSeconds);
    if (maxSeconds !== null && !(seconds && seconds > 0)) t = Math.min(t, maxSeconds);
    b.targetSeconds = t;
  }
  return b;
}

// ── items ───────────────────────────────────────────────────────────────────

/** An item as flat sentence indexes [first, last] (inclusive), in one chapter. */
export interface ItemSpan {
  first: number;
  last: number;
  chapter: number;
  words: number;
}

/**
 * Items of the sentences in lines [from, to) (a chapter): units by
 * granularity (a sentence; a paragraph; a sentence for g=time), units longer
 * than the upper bound split at sentence ends, then consecutive short units
 * merged until the lower bound (never past the upper bound). A short last item
 * joins the one before it when that stays within the upper bound.
 */
export function buildChapterItems(
  b: BookSentences,
  paragraphs: readonly Paragraph[],
  range: [number, number],
  chapter: number,
  granularity: Granularity,
  bounds: ItemBounds,
): ItemSpan[] {
  const wps = bounds.wordsPerSecond > 0 ? bounds.wordsPerSecond : PRIOR_WORDS_PER_SECOND;
  const minS =
    granularity === "time" ? (bounds.targetSeconds ?? bounds.minSeconds) : bounds.minSeconds;
  const maxS = bounds.maxSeconds ?? Infinity;
  const secs = (words: number) => words / wps;
  const first = b.lineStart[range[0]];
  const end = b.lineStart[range[1]];
  if (end <= first) return [];

  // Units as [first, last] sentence indexes.
  const units: [number, number][] = [];
  if (granularity === "paragraph") {
    for (const p of paragraphs) {
      if (p.end <= range[0] || p.start >= range[1]) continue;
      const a = b.lineStart[Math.max(p.start, range[0])];
      const z = b.lineStart[Math.min(p.end, range[1])] - 1;
      if (z >= a) units.push([a, z]);
    }
  } else for (let i = first; i < end; i++) units.push([i, i]);

  const words = (a: number, z: number) => {
    let n = 0;
    for (let i = a; i <= z; i++) n += b.load[i];
    return n;
  };

  // Split long units at sentence ends, each part within the upper bound.
  const parts: [number, number, number][] = [];
  for (const [a, z] of units) {
    const w = words(a, z);
    if (secs(w) <= maxS || a === z) {
      parts.push([a, z, w]);
      continue;
    }
    // As many parts as the bound needs, sized evenly, cut at sentence ends,
    // and never a part past the bound (unless one sentence alone is).
    const k = Math.ceil(secs(w) / maxS);
    const share = w / k;
    let start = a;
    let acc = 0;
    let done = 0;
    let made = 0;
    const cut = (last: number) => {
      parts.push([start, last, acc]);
      done += acc;
      made++;
      start = last + 1;
      acc = 0;
    };
    for (let i = a; i <= z; i++) {
      if (i > start && secs(acc + b.load[i]) > maxS) cut(i - 1);
      acc += b.load[i];
      if (i === z || done + acc >= share * (made + 1)) cut(i);
    }
  }

  // Merge short neighbours until the lower bound.
  const out: ItemSpan[] = [];
  let cur: ItemSpan | null = null;
  for (const [a, z, w] of parts) {
    if (cur && secs(cur.words) < minS && secs(cur.words + w) <= maxS) {
      cur.last = z;
      cur.words += w;
      continue;
    }
    if (cur) out.push(cur);
    cur = { first: a, last: z, chapter, words: w };
  }
  if (cur) {
    const prev = out[out.length - 1];
    if (prev && secs(cur.words) < minS && secs(prev.words + cur.words) <= maxS) {
      prev.last = cur.last;
      prev.words += cur.words;
    } else out.push(cur);
  }
  return out;
}

export function itemKey(b: BookSentences, span: Pick<ItemSpan, "first" | "last">): string {
  return `${sidOf(b, span.first)}+${span.last - span.first + 1}`;
}

export function estSeconds(words: number, bounds: Pick<ItemBounds, "wordsPerSecond">): number {
  const wps = bounds.wordsPerSecond > 0 ? bounds.wordsPerSecond : PRIOR_WORDS_PER_SECOND;
  return words / wps;
}
