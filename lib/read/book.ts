// The stored shape of a book imported into /read (first source: EPUB).
//
// A read_material keeps `lines: string[]` as before — every paragraph and
// heading of the book, in reading order — so everything that already reads
// `lines` keeps working. What a book adds lives in `content` as JSON
// (`BookMeta`): author, language, and chapters as start indexes into `lines`.
// Later book-as-goal work (chunked progressive reading, word/phrase
// extraction) builds on chapters + paragraphs from here; no migration needed.
// `words` (lib/read/words.ts) is the book's word count, made at import and
// backfilled on first read for books imported before it existed.

import { INLINE_KINDS, type InlineKind, type InlineMark } from "./reader-api";
import { countWords, parseWordStats, type WordStats } from "./words";
import { allowedSourceUrl } from "@/lib/books/catalogue";
import { checkRuns, type LangRuns } from "./lang-detect";
import { checkShape, type TextShape } from "./prep";

export const BOOK_KIND = "lianki-book";

export type BookSource = "epub" | "gdoc" | "preset" | "vibe";

/** Where a catalogue book (/books) came from, shown in the book: lib/books/catalogue.ts. */
export interface BookCredit {
  /** "<lang>/<slug>" of the catalogue entry. */
  preset: string;
  /** The source site, as shown ("Project Gutenberg"). */
  sourceName: string;
  licence: string;
  attribution: string;
}

export interface BookChapter {
  title: string;
  /** Index into `lines` of the chapter's first line. Ascending, first is 0. */
  start: number;
}

export interface BookMeta {
  kind: typeof BOOK_KIND;
  v: 1;
  /** Imported from: an EPUB file, a Google Doc (lib/gdoc), or a conversation (/vibe, lib/vibe). */
  source: BookSource;
  /** The Google Doc's link, for a "gdoc" book; the source page, for a "preset" one. */
  sourceUrl?: string;
  /** A catalogue book's source and licence (source "preset"). */
  credit?: BookCredit;
  author?: string;
  lang?: string;
  chapters: BookChapter[];
  /** Indexes into `lines` that are headings (h1–h6), for styling. */
  headings?: number[];
  /** Every distinct word with its count (lib/read/words.ts). */
  words?: WordStats;
  /** Inline emphasis from the EPUB (`lines` stay plain text). */
  marks?: InlineMark[];
  /** Lines that continue the paragraph before after a visible line break (`<br>`). */
  breaks?: number[];
  /** Lines that continue the paragraph before after a space (a long one split at import). */
  continues?: number[];
  /** Imported with inline markup and joins (books from before have none). */
  markup?: 1;
  /**
   * A book that mixes languages: each line's language, as runs [first line,
   * primary subtag] (lib/read/lang-detect.ts). Sentences, read-aloud, lookup,
   * translation and 制卡 use a line's own; `lang` stays the book's primary.
   */
  langs?: LangRuns;
  /** What the import's detector found (lib/read/prep.ts): the polish offer reads it. */
  shape?: TextShape;
  /** The AI polish of a raw transcript (lib/read/polish.ts); the raw text is kept beside it. */
  polished?: PolishInfo;
}

/** A polish that was applied: when, and how many of its chunks passed the check. */
export interface PolishInfo {
  at: string;
  chunks: number;
  kept: number;
}

/** The book text's markup, kept beside the plain lines. */
export interface BookMarkup {
  marks: InlineMark[];
  breaks: number[];
  continues: number[];
}

export interface ParsedBook extends Partial<BookMarkup> {
  title: string;
  author?: string;
  lang?: string;
  lines: string[];
  chapters: BookChapter[];
  headings: number[];
}

// Limits for what the server stores. The D1 row limit is 2 MB; `lines` goes in
// one column, so the text must stay well under it.
export const BOOK_LIMITS = {
  maxLines: 40_000,
  maxLineChars: 8_000,
  maxTextBytes: 1_500_000,
  maxChapters: 2_000,
  maxTitleChars: 300,
  maxMarks: 100_000,
};

const KINDS = new Set<string>(INLINE_KINDS);

/**
 * Untrusted markup checked against the lines: kinds from the closed set,
 * integer ranges inside their line, joins ascending and never line 0.
 * Anything else is dropped, not refused: the book stays readable as text.
 */
export function checkMarkup(
  b: Record<string, unknown>,
  /** Null: shape only (stored meta, read without its lines). */
  lines: readonly string[] | null,
): BookMarkup | null {
  if (!Array.isArray(b.marks) && !Array.isArray(b.breaks) && !Array.isArray(b.continues))
    return null;
  const marks: InlineMark[] = [];
  for (const m of Array.isArray(b.marks) ? b.marks.slice(0, BOOK_LIMITS.maxMarks) : []) {
    if (!Array.isArray(m) || m.length !== 4) continue;
    const [l, a, z, k] = m as unknown[];
    if (!Number.isInteger(l) || !Number.isInteger(a) || !Number.isInteger(z)) continue;
    if ((l as number) < 0 || (a as number) < 0 || (z as number) <= (a as number)) continue;
    const line = lines ? lines[l as number] : "";
    if (line === undefined || (lines && (z as number) > line.length)) continue;
    if (typeof k !== "string" || !KINDS.has(k)) continue;
    marks.push([l as number, a as number, z as number, k as InlineKind]);
  }
  const joins = (v: unknown) => {
    if (!Array.isArray(v)) return [];
    const out: number[] = [];
    for (const x of v) {
      if (!Number.isInteger(x) || x <= 0 || (lines && x >= lines.length)) continue;
      if (out.length && x <= out[out.length - 1]) continue;
      out.push(x);
    }
    return out;
  };
  const breaks = joins(b.breaks);
  const br = new Set(breaks);
  const continues = joins(b.continues).filter((x) => !br.has(x));
  return { marks, breaks, continues };
}

export type BookCheck = { ok: true; book: ParsedBook } | { ok: false; error: string };

const enc = new TextEncoder();

/** Validate an untrusted parsed book (from the browser) before it is stored. */
export function checkBook(input: unknown): BookCheck {
  if (!input || typeof input !== "object") return { ok: false, error: "book must be an object" };
  const b = input as Record<string, unknown>;
  const str = (v: unknown, max: number) =>
    typeof v === "string" && v.trim() ? v.normalize("NFC").trim().slice(0, max) : undefined;
  const title = str(b.title, BOOK_LIMITS.maxTitleChars);
  if (!title) return { ok: false, error: "title is required" };
  if (!Array.isArray(b.lines) || b.lines.length === 0)
    return { ok: false, error: "lines are required" };
  if (b.lines.length > BOOK_LIMITS.maxLines) return { ok: false, error: "too-much-text" };
  const lines: string[] = [];
  for (const l of b.lines) {
    if (typeof l !== "string") return { ok: false, error: "lines must be strings" };
    const line = l.normalize("NFC").trim().slice(0, BOOK_LIMITS.maxLineChars);
    if (!line) return { ok: false, error: "empty line" };
    lines.push(line);
  }
  // Measured as stored: the JSON column, escapes included (\u0001 is 6 bytes).
  if (enc.encode(JSON.stringify(lines)).length > BOOK_LIMITS.maxTextBytes) {
    return { ok: false, error: "too-much-text" };
  }

  const rawCh = Array.isArray(b.chapters) ? b.chapters : [];
  if (rawCh.length > BOOK_LIMITS.maxChapters) return { ok: false, error: "too many chapters" };
  const chapters: BookChapter[] = [];
  for (const c of rawCh) {
    const ch = c as Record<string, unknown>;
    const start = ch?.start;
    if (
      typeof start !== "number" ||
      !Number.isInteger(start) ||
      start < 0 ||
      start >= lines.length
    ) {
      return { ok: false, error: "chapter start out of range" };
    }
    if (chapters.length && start <= chapters[chapters.length - 1].start) {
      return { ok: false, error: "chapters must ascend" };
    }
    chapters.push({
      title: str(ch.title, BOOK_LIMITS.maxTitleChars) ?? `${chapters.length + 1}`,
      start,
    });
  }
  if (chapters.length && chapters[0].start !== 0) chapters.unshift({ title: title, start: 0 });

  const headings = Array.isArray(b.headings)
    ? b.headings
        .filter((h): h is number => Number.isInteger(h) && h >= 0 && h < lines.length)
        .slice(0, BOOK_LIMITS.maxLines)
    : [];

  const markup = checkMarkup(b, lines);
  return {
    ok: true,
    book: {
      title,
      author: str(b.author, BOOK_LIMITS.maxTitleChars),
      lang: str(b.lang, 35),
      lines,
      chapters,
      headings,
      ...markup,
    },
  };
}

export function bookMetaOf(
  book: ParsedBook & { langs?: LangRuns },
  from: {
    source: BookSource;
    sourceUrl?: string;
    credit?: BookCredit;
    shape?: TextShape;
    polished?: PolishInfo;
  } = { source: "epub" },
): BookMeta {
  return {
    kind: BOOK_KIND,
    v: 1,
    source: from.source,
    ...(from.sourceUrl ? { sourceUrl: from.sourceUrl } : {}),
    ...(from.credit ? { credit: from.credit } : {}),
    ...(book.author ? { author: book.author } : {}),
    ...(book.lang ? { lang: book.lang } : {}),
    chapters: book.chapters,
    headings: book.headings,
    words: countWords(book.lines, book.lang),
    ...(book.marks || book.breaks || book.continues
      ? {
          marks: book.marks ?? [],
          breaks: book.breaks ?? [],
          continues: book.continues ?? [],
          markup: 1 as const,
        }
      : {}),
    ...(book.langs?.length ? { langs: book.langs } : {}),
    ...(from.shape ? { shape: from.shape } : {}),
    ...(from.polished ? { polished: from.polished } : {}),
  };
}

const cap = (v: unknown, max: number) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

/** A catalogue book's source link and credit, kept only when the link is on a source host. */
function presetCredit(m: BookMeta): Pick<BookMeta, "sourceUrl" | "credit"> {
  const url = typeof m.sourceUrl === "string" ? allowedSourceUrl(m.sourceUrl) : null;
  const c = (m.credit ?? {}) as Partial<BookCredit>;
  const preset = cap(c.preset, 200);
  const sourceName = cap(c.sourceName, 100);
  const licence = cap(c.licence, 500);
  const attribution = cap(c.attribution, 1000);
  if (!url || !preset || !sourceName || !licence || !attribution) return {};
  return { sourceUrl: url.toString(), credit: { preset, sourceName, licence, attribution } };
}

/** The book meta stored in a material's `content`, or null for plain text. */
export function parseBookMeta(content: string | undefined | null): BookMeta | null {
  if (!content || !content.startsWith(`{"kind":"${BOOK_KIND}"`)) return null;
  try {
    const m = JSON.parse(content) as BookMeta;
    if (m?.kind !== BOOK_KIND || !Array.isArray(m.chapters)) return null;
    // `content` of a plain-text import is free text that could mimic this
    // shape: keep only sane, ascending chapter starts and heading indexes.
    const chapters: BookChapter[] = [];
    for (const c of m.chapters) {
      const start = c?.start;
      if (!Number.isInteger(start) || start < 0 || start > 10_000_000) continue;
      if (chapters.length && start <= chapters[chapters.length - 1].start) continue;
      chapters.push({
        title: typeof c.title === "string" ? c.title : String(chapters.length + 1),
        start,
      });
    }
    const headings = Array.isArray(m.headings)
      ? m.headings.filter((h) => Number.isInteger(h) && h >= 0)
      : [];
    const words = parseWordStats(m.words);
    // Lines are not known here: ranges are checked against them when used
    // (lib/read/units.ts); here only the shape.
    const markup =
      m.markup === 1 ? checkMarkup(m as unknown as Record<string, unknown>, null) : null;
    const langs = checkRuns(m.langs, null);
    const shape = checkShape(m.shape);
    const p = m.polished as Partial<PolishInfo> | undefined;
    const polished =
      p && typeof p.at === "string" && Number.isInteger(p.chunks) && Number.isInteger(p.kept)
        ? { at: p.at.slice(0, 40), chunks: p.chunks!, kept: p.kept! }
        : null;
    return {
      kind: BOOK_KIND,
      v: 1,
      source:
        m.source === "gdoc" || m.source === "preset" || m.source === "vibe" ? m.source : "epub",
      ...(m.source === "preset" ? presetCredit(m) : {}),
      ...(m.source === "gdoc" &&
      typeof m.sourceUrl === "string" &&
      /^https:\/\/docs\.google\.com\/document\/d\/[A-Za-z0-9_-]{25,128}\/edit$/.test(m.sourceUrl)
        ? { sourceUrl: m.sourceUrl }
        : {}),
      ...(typeof m.author === "string" ? { author: m.author } : {}),
      ...(typeof m.lang === "string" ? { lang: m.lang } : {}),
      chapters,
      headings,
      ...(words ? { words } : {}),
      ...(markup ? { ...markup, markup: 1 as const } : {}),
      ...(langs ? { langs } : {}),
      ...(shape ? { shape } : {}),
      ...(polished ? { polished } : {}),
    };
  } catch {
    return null;
  }
}

/** The chapter index that contains `line`. */
export function chapterAt(chapters: BookChapter[], line: number): number {
  let lo = 0;
  let hi = chapters.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (chapters[mid].start <= line) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}
