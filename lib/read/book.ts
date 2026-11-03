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

import { countWords, parseWordStats, type WordStats } from "./words";

export const BOOK_KIND = "lianki-book";

export interface BookChapter {
  title: string;
  /** Index into `lines` of the chapter's first line. Ascending, first is 0. */
  start: number;
}

export interface BookMeta {
  kind: typeof BOOK_KIND;
  v: 1;
  source: "epub";
  author?: string;
  lang?: string;
  chapters: BookChapter[];
  /** Indexes into `lines` that are headings (h1–h6), for styling. */
  headings?: number[];
  /** Every distinct word with its count (lib/read/words.ts). */
  words?: WordStats;
}

export interface ParsedBook {
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
};

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

  return {
    ok: true,
    book: {
      title,
      author: str(b.author, BOOK_LIMITS.maxTitleChars),
      lang: str(b.lang, 35),
      lines,
      chapters,
      headings,
    },
  };
}

export function bookMetaOf(book: ParsedBook): BookMeta {
  return {
    kind: BOOK_KIND,
    v: 1,
    source: "epub",
    ...(book.author ? { author: book.author } : {}),
    ...(book.lang ? { lang: book.lang } : {}),
    chapters: book.chapters,
    headings: book.headings,
    words: countWords(book.lines, book.lang),
  };
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
    return {
      kind: BOOK_KIND,
      v: 1,
      source: "epub",
      ...(typeof m.author === "string" ? { author: m.author } : {}),
      ...(typeof m.lang === "string" ? { lang: m.lang } : {}),
      chapters,
      headings,
      ...(words ? { words } : {}),
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
