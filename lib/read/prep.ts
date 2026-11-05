// Before a book is stored: what kind of text it is, and the text cut into
// bite-size paragraphs (docs/books-plan.md, "Import pipeline"). Pure and
// isomorphic; no AI. Owner, 2026-11-05: an imported Google Doc that was a raw
// speech-to-text transcript, in two languages, read as one huge paragraph.
//
// 1. **Detect** (`detectShape`): raw-transcript-like, mixed-language, or
//    already structured — from ratios of the text itself, no fixed counts.
// 2. **Bite size** (`biteSize`, always): every paragraph and line break its
//    own paragraph; a paragraph cut where its language changes; one longer
//    than the upper end of the 1–3 minute rule at the reader's own pace (a
//    raw transcript: 1.5× its lower end) cut at sentence ends into pieces of
//    about the lower end; a sentence longer
//    than that (no punctuation) cut at its pauses (clause punctuation,
//    hesitation sounds), else between words. Each line keeps its language.
// 3. An optional AI polish on top (lib/read/polish.ts), offered when the
//    detector says raw transcript; never silent, the raw text kept.

import { FILLERS } from "./lang";
import {
  detectLangs,
  primaryLang,
  sharedLang,
  toRuns,
  unitLang,
  type LangRuns,
} from "./lang-detect";
import type { BookChapter, ParsedBook } from "./book";
import type { InlineMark } from "./reader-api";
import { CHUNK_SECONDS, PRIOR_WORDS_PER_SECOND, readingLoad, segmentLine } from "./units";
import { wordSegments } from "./word-segments";

export { CHUNK_SECONDS };

/** Bump when detection changes, so a stored shape is made again. */
export const SHAPE_V = 1;

/** What the detector found, stored on the material (BookMeta.shape). */
export interface TextShape {
  v: typeof SHAPE_V;
  /** Reads like a raw speech-to-text transcript: offer the polish. */
  raw: boolean;
  /** More than one language: each line has its own (BookMeta.langs). */
  mixed: boolean;
  /** The languages found, heaviest first. */
  langs: string[];
  /** The signals, as shares 0..1 of the body's words (or sentences), two decimals. */
  signals: { longParas: number; lowerStarts: number; unended: number; fillers: number };
}

const CASED = (ch: string) => ch.toLowerCase() !== ch.toUpperCase();
const FIRST_LETTER = /\p{L}/u;
const ENDS = /\p{Sentence_Terminal}[\p{Pe}\p{Pf}\p{Po}"'”’」』）)]*\s*$/u;
const r2 = (x: number) => Math.round(x * 100) / 100;

let fillerRes: RegExp[] | null = null;
/** One pattern per hesitation sound: a whole word in spaced scripts, as written in the others. */
function fillerPatterns(): RegExp[] {
  return (fillerRes ??= FILLERS.map((f) =>
    /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(f)
      ? new RegExp(escapeRe(f), "giu")
      : new RegExp(`(?<![\\p{L}\\p{M}])${escapeRe(f)}(?![\\p{L}\\p{M}])`, "giu"),
  ));
}

/** Hesitation sounds in a text (LangData.fillers). */
export function fillerCount(text: string): number {
  let n = 0;
  for (const re of fillerPatterns()) n += text.match(re)?.length ?? 0;
  return n;
}

/** The text without its hesitation sounds. */
export function stripFillers(text: string): string {
  let t = text;
  for (const re of fillerPatterns()) t = t.replace(re, " ");
  return t;
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The text's shape. Every test is a majority of the text itself:
 * - long paragraphs: most of the body's words sit in paragraphs past the
 *   upper end of the 1–3 minute rule (at `wordsPerSecond`);
 * - and one transcript sign: most sentences of a cased script start in lower
 *   case; most words sit in sentences with no sentence-ending mark; or
 *   hesitation sounds outnumber the paragraphs (a written text has none).
 */
export function detectShape(
  lines: readonly string[],
  headings: ReadonlySet<number>,
  opts: { wordsPerSecond?: number; langs?: readonly string[] } = {},
): TextShape {
  const wps =
    opts.wordsPerSecond && opts.wordsPerSecond > 0 ? opts.wordsPerSecond : PRIOR_WORDS_PER_SECOND;
  const body: number[] = [];
  lines.forEach((l, i) => {
    if (!headings.has(i) && l.trim()) body.push(i);
  });
  const texts = body.map((i) => lines[i]);
  const shared = sharedLang(texts);
  const langs = opts.langs ?? detectLangs(texts, shared);
  let words = 0;
  let longWords = 0;
  let cased = 0;
  let lower = 0;
  let unended = 0;
  let fillers = 0;
  const weight = new Map<string, number>();
  body.forEach((line, k) => {
    const text = lines[line];
    const lang = opts.langs ? (opts.langs[line] ?? shared) : langs[k];
    const w = readingLoad(text, lang);
    words += w;
    weight.set(lang, (weight.get(lang) ?? 0) + w);
    if (w / wps > CHUNK_SECONDS.high) longWords += w;
    fillers += fillerCount(text);
    for (const [a, z] of segmentLine(text, lang)) {
      const s = text.slice(a, z);
      const first = FIRST_LETTER.exec(s)?.[0];
      if (first && CASED(first)) {
        cased++;
        if (first === first.toLowerCase()) lower++;
      }
      if (!ENDS.test(s)) unended += readingLoad(s, lang);
    }
  });
  const share = (n: number, d: number) => (d > 0 ? n / d : 0);
  const signals = {
    longParas: r2(share(longWords, words)),
    lowerStarts: r2(share(lower, cased)),
    unended: r2(share(unended, words)),
    fillers: r2(share(fillers, fillers + body.length)),
  };
  const raw =
    signals.longParas > 0.5 &&
    (signals.lowerStarts > 0.5 || signals.unended > 0.5 || signals.fillers > 0.5);
  const order = [...weight].sort((a, b) => b[1] - a[1]).map(([l]) => l);
  return { v: SHAPE_V, raw, mixed: order.length > 1, langs: order, signals };
}

/** detectShape on a parsed book's paragraphs as written (a long one split at import joined again). */
export function detectBook(
  book: Pick<ParsedBook, "lines" | "headings" | "continues">,
  opts: { wordsPerSecond?: number } = {},
): TextShape {
  const heads = new Set(book.headings);
  const cont = new Set(book.continues ?? []);
  const lines: string[] = [];
  const h = new Set<number>();
  book.lines.forEach((l, i) => {
    if (cont.has(i) && lines.length && !heads.has(i) && !heads.has(i - 1)) {
      lines[lines.length - 1] += joinSep(lines[lines.length - 1], l) + l;
      return;
    }
    if (heads.has(i)) h.add(lines.length);
    lines.push(l);
  });
  return detectShape(lines, h, opts);
}

// ── bite size ───────────────────────────────────────────────────────────────

const CHAR_WORD = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/** Punctuation inside a sentence that marks a pause: commas, semicolons, colons, dashes (any script). */
const PAUSE = /[\p{Terminal_Punctuation}\p{Pd}]\s*$/u;

/** Where a too-long stretch of text may be cut: offsets, with how good a cut each is. */
function pauseCuts(text: string, lang: string): { at: number; words: number; rank: number }[] {
  const seg = new Intl.Segmenter(lang === "und" ? undefined : lang, { granularity: "word" });
  const out: { at: number; words: number; rank: number }[] = [];
  let words = 0;
  for (const s of wordSegments(seg, text)) {
    if (!s.isWordLike) continue;
    if (words > 0) {
      const before = text.slice(0, s.index);
      const filler = fillerCount(s.segment) > 0;
      out.push({ at: s.index, words, rank: PAUSE.test(before) ? 2 : filler ? 1 : 0 });
    }
    words++;
  }
  return out;
}

/**
 * Offsets that cut `text` (one over-long sentence, or a run of them) into
 * pieces of about `target` words: the best pause in the second half of each
 * piece's window, else the window's end.
 */
export function cutAtPauses(text: string, lang: string, target: number): number[] {
  const cuts = pauseCuts(text, lang);
  const total = readingLoad(text, lang);
  const out: number[] = [];
  let base = 0;
  while (total - base > target * 1.5) {
    const window = cuts.filter((c) => c.words - base >= target / 2 && c.words - base <= target);
    let pick = window.reduce<(typeof cuts)[number] | null>(
      (b, c) => (!b || c.rank > b.rank || (c.rank === b.rank && c.words > b.words) ? c : b),
      null,
    );
    pick ??= cuts.find((c) => c.words - base >= target) ?? null;
    if (!pick) break;
    out.push(pick.at);
    base = pick.words;
  }
  return out;
}

export interface BiteOptions {
  /** The reader's speed in this text's language (lib/read/units.ts itemBounds); else the prior. */
  wordsPerSecond?: number;
  /** A `<br>` starts its own paragraph (a Google Doc's soft return); else it stays a break inside one. */
  splitBreaks?: boolean;
  /**
   * The detector found a raw transcript (detectShape): paragraphs are cut
   * from 1.5× the lower end of the rule, not only past its upper end — a
   * transcript has no paragraphs of its own to keep.
   */
  raw?: boolean;
}

export interface BiteBook extends ParsedBook {
  /** Each line's language, as runs (BookMeta.langs); absent when the book has one. */
  langs?: LangRuns;
}

/** A source paragraph: its lines, its text (lines joined), where each line starts in it. */
interface SrcPara {
  lines: number[];
  text: string;
  starts: number[];
}

const joinSep = (a: string, b: string) =>
  CHAR_WORD.test(a.at(-1) ?? "") && CHAR_WORD.test(b[0] ?? "") ? "" : " ";

/**
 * The book cut into bite-size paragraphs (see the top of the file). Lines
 * that are already short enough and of one language come out unchanged, so
 * a well-made book is left as it is; marks follow their text; headings and
 * chapter starts stay on their lines.
 */
export function biteSize(book: ParsedBook, opts: BiteOptions = {}): BiteBook {
  const wps =
    opts.wordsPerSecond && opts.wordsPerSecond > 0 ? opts.wordsPerSecond : PRIOR_WORDS_PER_SECOND;
  const heads = new Set(book.headings);
  const cont = new Set(book.continues ?? []);
  const br = new Set(book.breaks ?? []);

  // Source paragraphs: a line joins the one before when it continues it (a
  // long paragraph split at import), or follows a <br> that stays a break.
  const paras: SrcPara[] = [];
  const joinedBr: number[] = [];
  book.lines.forEach((l, i) => {
    const prev = paras[paras.length - 1];
    const joins =
      prev &&
      !heads.has(i) &&
      !heads.has(i - 1) &&
      (cont.has(i) || (br.has(i) && !opts.splitBreaks));
    if (joins) {
      if (br.has(i)) {
        // A break kept inside a paragraph stays its own line (as before).
        paras.push({ lines: [i], text: l, starts: [0] });
        joinedBr.push(i);
        return;
      }
      const sep = joinSep(prev.text, l);
      prev.starts.push(prev.text.length + sep.length);
      prev.text += sep + l;
      prev.lines.push(i);
    } else paras.push({ lines: [i], text: l, starts: [0] });
  });

  const marksBy = new Map<number, InlineMark[]>();
  for (const m of book.marks ?? []) {
    const list = marksBy.get(m[0]) ?? [];
    list.push(m);
    marksBy.set(m[0], list);
  }

  const bodyTexts = paras.filter((p) => !heads.has(p.lines[0])).map((p) => p.text);
  const shared = sharedLang(bodyTexts);
  const primary = book.lang?.split(/[-_]/)[0]?.toLowerCase() || primaryLang(bodyTexts, shared);
  const high = wps * CHUNK_SECONDS.high;
  const low = wps * CHUNK_SECONDS.low;

  const lines: string[] = [];
  const langs: string[] = [];
  const headings: number[] = [];
  const marks: InlineMark[] = [];
  const breaks: number[] = [];
  const newLineOf = new Map<number, number>();
  const brSet = new Set(joinedBr);

  const emit = (p: SrcPara, a: number, z: number, lang: string) => {
    // Trim, keeping offsets.
    while (a < z && /\s/u.test(p.text[a])) a++;
    while (z > a && /\s/u.test(p.text[z - 1])) z--;
    if (z <= a) return;
    const line = lines.length;
    // Source lines starting in [a, z) map here (the first output line holding them).
    p.lines.forEach((src, k) => {
      const s = p.starts[k];
      if (!newLineOf.has(src) && s < z && (s >= a || k === 0)) newLineOf.set(src, line);
    });
    if (brSet.has(p.lines[0]) && a === firstNonWs(p.text)) breaks.push(line);
    p.lines.forEach((src, k) => {
      for (const [, s, e, kind] of marksBy.get(src) ?? []) {
        const ms = Math.max(a, p.starts[k] + s);
        const me = Math.min(z, p.starts[k] + e);
        if (me > ms) marks.push([line, ms - a, me - a, kind]);
      }
    });
    lines.push(p.text.slice(a, z));
    langs.push(lang);
  };

  for (const p of paras) {
    if (heads.has(p.lines[0])) {
      headings.push(lines.length);
      newLineOf.set(p.lines[0], lines.length);
      lines.push(p.text);
      langs.push(unitLang(p.text, shared) ?? primary);
      for (const [, s, e, kind] of marksBy.get(p.lines[0]) ?? [])
        marks.push([lines.length - 1, s, e, kind]);
      continue;
    }
    const paraLang = unitLang(p.text, shared) ?? primary;
    const sents = segmentLine(p.text, paraLang);
    if (!sents.length) continue;
    const sl = detectLangs(
      sents.map(([a, z]) => p.text.slice(a, z)),
      shared,
    );
    // Runs of one language, as sentence index ranges.
    let r0 = 0;
    for (let s = 1; s <= sents.length; s++) {
      if (s < sents.length && sl[s] === sl[r0]) continue;
      const lang = sl[r0];
      const a = r0 === 0 ? 0 : sents[r0][0];
      const z = s === sents.length ? p.text.length : sents[s][0];
      const runSents = sents.slice(r0, s);
      const load = (i: number) => readingLoad(p.text.slice(runSents[i][0], runSents[i][1]), lang);
      const total = runSents.reduce((n, _, i) => n + load(i), 0);
      if (total <= (opts.raw ? low * 1.5 : high)) emit(p, a, z, lang);
      else {
        // Pieces of about the lower end, cut at sentence ends; a sentence
        // longer than that is cut at its pauses.
        const k = Math.max(2, Math.round(total / low));
        const share = total / k;
        let start = a;
        let acc = 0;
        let done = 0;
        let made = 0;
        for (let i = 0; i < runSents.length; i++) {
          const w = load(i);
          const [sa, sz] = runSents[i];
          if (w > low * 1.5) {
            if (acc > 0) {
              emit(p, start, sa, lang);
              done += acc;
              made++;
              acc = 0;
            }
            const cuts = cutAtPauses(p.text.slice(sa, sz), lang, low);
            let from = sa;
            for (const c of cuts) {
              emit(p, from, sa + c, lang);
              from = sa + c;
            }
            start = from;
            acc = readingLoad(p.text.slice(from, sz), lang);
            continue;
          }
          acc += w;
          if (done + acc >= share * (made + 1) && i < runSents.length - 1) {
            const next = runSents[i + 1][0];
            emit(p, start, next, lang);
            done += acc;
            made++;
            acc = 0;
            start = next;
          }
        }
        emit(p, start, z, lang);
      }
      r0 = s;
    }
  }

  const chapters: BookChapter[] = [];
  for (const c of book.chapters) {
    let start = newLineOf.get(c.start);
    for (let l = c.start; start === undefined && l < book.lines.length; l++)
      start = newLineOf.get(l);
    if (start === undefined) continue;
    if (chapters.length && start <= chapters[chapters.length - 1].start) continue;
    chapters.push({ ...c, start });
  }
  if (chapters.length && chapters[0].start !== 0) chapters[0] = { ...chapters[0], start: 0 };

  const distinct = new Set(langs);
  const markup = book.marks || book.breaks || book.continues;
  return {
    ...book,
    lang: book.lang ?? primary,
    lines,
    headings,
    chapters,
    ...(markup ? { marks, breaks, continues: [] } : {}),
    ...(distinct.size > 1 ? { langs: toRuns(langs) } : {}),
  };
}

/** A stored shape (untrusted JSON), or null when it is missing, malformed or of an older detector. */
export function checkShape(v: unknown): TextShape | null {
  const s = v as Partial<TextShape> | null;
  if (!s || typeof s !== "object" || s.v !== SHAPE_V) return null;
  if (typeof s.raw !== "boolean" || typeof s.mixed !== "boolean") return null;
  const langs = Array.isArray(s.langs)
    ? s.langs
        .filter((l): l is string => typeof l === "string" && /^[a-z]{2,3}$/.test(l))
        .slice(0, 20)
    : [];
  const g = (s.signals ?? {}) as Record<string, unknown>;
  const num = (x: unknown) => (typeof x === "number" && x >= 0 && x <= 1 ? x : 0);
  return {
    v: SHAPE_V,
    raw: s.raw,
    mixed: s.mixed,
    langs,
    signals: {
      longParas: num(g.longParas),
      lowerStarts: num(g.lowerStarts),
      unended: num(g.unended),
      fillers: num(g.fillers),
    },
  };
}

const firstNonWs = (s: string) => {
  const m = /\S/u.exec(s);
  return m ? m.index : 0;
};
