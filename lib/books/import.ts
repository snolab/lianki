// One tap on /books: the catalogue book becomes the user's own book in /read
// (a read_material keyed `preset:<lang>/<slug>`). Importing it again opens the
// book they already have; nothing is fetched or parsed for that.
//
// The text comes from the shared source cache (lib/books/source.ts): fetched
// from the source once for all users, parsed per import. The book's meta
// carries the source link, licence and attribution, shown in the reader.

import { bookMetaOf, checkBook, type BookMeta } from "@/lib/read/book";
import { bookHash } from "@/lib/read/units";
import { bookKey, presetSourceKey, type CatalogueBook } from "./catalogue";
import { BookSourceFail, loadSource, parseSource, type SourceCache } from "./source";

export interface ImportDeps {
  /** The user's book from this source key, if any. */
  find(userId: string, sourceKey: string): Promise<{ id: string } | null>;
  save(
    userId: string,
    title: string,
    content: string,
    lines: string[],
    hash: string,
    sourceKey: string,
  ): Promise<{ id: string }>;
  cache: SourceCache | null;
  fetchImpl?: typeof fetch;
}

export interface ImportResult {
  id: string;
  /** The user already had it: opened, not imported again. */
  existing: boolean;
  /** The source came from the shared cache (not fetched now). */
  cached?: boolean;
  lineCount?: number;
}

/** The meta stored with an imported catalogue book. */
export function presetMeta(
  book: CatalogueBook,
  parsed: Parameters<typeof bookMetaOf>[0],
): BookMeta {
  return bookMetaOf(parsed, {
    source: "preset",
    sourceUrl: book.source.page,
    credit: {
      preset: bookKey(book),
      sourceName: book.source.name,
      licence: book.licence,
      attribution: book.attribution,
    },
  });
}

export async function importCatalogueBook(
  userId: string,
  book: CatalogueBook,
  deps: ImportDeps,
): Promise<ImportResult> {
  const key = presetSourceKey(book);
  const prev = await deps.find(userId, key);
  if (prev) return { id: prev.id, existing: true };

  const { html, cached } = await loadSource(book, deps.cache, deps.fetchImpl);
  const checked = checkBook(parseSource(book, html));
  if (!checked.ok)
    throw new BookSourceFail(checked.error === "too-much-text" ? "too-large" : "no-text");
  const b = checked.book;
  const content = JSON.stringify(presetMeta(book, b));
  const hash = await bookHash(b.lines);
  const saved = await deps.save(userId, b.title, content, b.lines, hash, key);
  return { id: saved.id, existing: false, cached, lineCount: b.lines.length };
}
