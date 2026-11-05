// The import pipeline's server side (lib/read/prep.ts; docs/books-plan.md,
// "Import pipeline"): detect, then cut into bite size at the reader's own
// pace in the text's language. Used by every import that stores a book.
import type { D1Like } from "@/lib/d1/types";
import { checkBook, type ParsedBook } from "./book";
import { primaryLang } from "./lang-detect";
import type { LangRuns } from "./lang-detect";
import { biteSize, detectBook, type TextShape } from "./prep";
import { readSamples } from "./reader-store";
import { itemBounds, PRIOR_WORDS_PER_SECOND } from "./units";

export interface PreparedBook {
  book: ParsedBook & { langs?: LangRuns };
  shape: TextShape;
}

/** The reader's own speed in a language (words a second), else the prior. */
export async function readerSpeed(
  db: D1Like | null,
  userId: string,
  lang: string,
): Promise<number> {
  if (!db) return PRIOR_WORDS_PER_SECOND;
  try {
    return itemBounds(await readSamples(db, userId, lang), "paragraph").wordsPerSecond;
  } catch (err) {
    console.error("read: reading speed failed, using the prior", String(err).slice(0, 200));
    return PRIOR_WORDS_PER_SECOND;
  }
}

/**
 * A checked book through the pipeline: the shape of the text as written,
 * then the bite-size book (checked again: what is stored is always valid).
 * `splitBreaks`: a line break starts its own paragraph (a Google Doc).
 */
export async function prepareBook(
  book: ParsedBook,
  ctx: { db: D1Like | null; userId: string; splitBreaks?: boolean },
): Promise<PreparedBook> {
  const lang = book.lang?.split(/[-_]/)[0]?.toLowerCase() || primaryLang(book.lines);
  const wps = await readerSpeed(ctx.db, ctx.userId, lang);
  const shape = detectBook(book, { wordsPerSecond: wps });
  const cut = biteSize(book, { wordsPerSecond: wps, splitBreaks: ctx.splitBreaks, raw: shape.raw });
  const checked = checkBook(cut);
  // The cut book is made of the checked one's text: it cannot fail, but a
  // book is never stored unchecked, so the input stands if it does.
  if (!checked.ok) return { book, shape };
  return {
    book: { ...checked.book, ...(cut.langs ? { langs: cut.langs } : {}) },
    shape: { ...shape, mixed: !!cut.langs },
  };
}
