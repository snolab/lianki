// My books (/books): the user's own shelf (docs/books-plan.md, "/library and
// /books"). A book is on it when it is one of their read_materials keyed by
// where a book came from:
//
// - `preset:<lang>/<slug>` — added from the catalogue (/library);
// - `file:<id>` — a book file they imported themselves (stored in My Files).
//
// Pasted text, Google Docs, vibes and songs stay in /reader only. One query,
// scoped to the user; no book text is read for the list.

import { catalogueBook, type CatalogueBook } from "./catalogue";

export type ShelfOrigin = "library" | "file";

export interface ShelfBook {
  /** The read_material id: the book opens at /reader/<id>. */
  id: string;
  title: string;
  author?: string;
  /** BCP 47, as the book states it; "" when unknown. */
  lang: string;
  origin: ShelfOrigin;
  /** "<lang>/<slug>" of a catalogue book. */
  key?: string;
  /** ISO time of the last change (reading, import). */
  updatedAt: string;
  /** An own book with a cover: GET /api/books/mine/<id>/cover. */
  cover?: boolean;
}

/** What an own book's meta says about it (lib/read/book.ts BookMeta). */
export type FileInfo = { lang?: string; author?: string; cover?: boolean };

export interface ShelfRow {
  id: string;
  title: string;
  source_key: string;
  updated_at: string;
  /** Inline meta (small books), else in R2 at r2_key: read for own books only. */
  content?: string | null;
  r2_key?: string | null;
}

/** The SQL prefixes that put a material on the shelf (LIKE patterns). */
export const SHELF_SOURCE_PATTERNS = ["preset:%", "file:%"] as const;

/**
 * A row → a shelf book; null for a row that is not a book. `lookup` names a
 * catalogue entry (curated or shared) for a `preset:` key, for its author.
 */
export function shelfBook(
  row: ShelfRow,
  lookup: (key: string) => CatalogueBook | null = catalogueBook,
  fileInfo: (id: string) => FileInfo | undefined = () => undefined,
): ShelfBook | null {
  const k = row.source_key ?? "";
  if (k.startsWith("preset:")) {
    const key = k.slice("preset:".length);
    const lang = key.split("/")[0] ?? "";
    const entry = lookup(key);
    return {
      id: row.id,
      title: row.title,
      ...(entry?.author ? { author: entry.author } : {}),
      lang,
      origin: "library",
      key,
      updatedAt: row.updated_at,
    };
  }
  if (k.startsWith("file:")) {
    const info = fileInfo(row.id);
    return {
      id: row.id,
      title: row.title,
      ...(info?.author ? { author: info.author } : {}),
      lang: info?.lang ?? "",
      origin: "file",
      updatedAt: row.updated_at,
      ...(info?.cover ? { cover: true } : {}),
    };
  }
  return null;
}

/** Shelf books grouped by language, groups in first-seen order (newest book first); "" last. */
export function shelfByLang(books: ShelfBook[]): [string, ShelfBook[]][] {
  const groups = new Map<string, ShelfBook[]>();
  for (const b of books) groups.set(b.lang, [...(groups.get(b.lang) ?? []), b]);
  return [...groups.entries()].sort((a, b) => Number(a[0] === "") - Number(b[0] === ""));
}

/** The D1 slice used here (the real binding, or lib/d1/testDb.ts). */
type Db = {
  prepare(sql: string): {
    bind(...v: unknown[]): { all<T>(): Promise<{ results?: T[] }> };
  };
};

/** The user's shelf rows, newest first. */
export async function shelfRows(db: Db, userId: string): Promise<ShelfRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, title, source_key, updated_at, content, r2_key FROM read_materials
       WHERE user_id = ? AND (source_key LIKE ? OR source_key LIKE ?)
       ORDER BY updated_at DESC LIMIT 1000`,
    )
    .bind(userId, ...SHELF_SOURCE_PATTERNS)
    .all<ShelfRow>();
  return results ?? [];
}
