// The shared part of the /books catalogue: works a user imported from a
// pasted link or a library search after the admission rule confirmed them
// (lib/books/resolve.ts). Stored in D1 (`shared_books`), one row per work,
// listed for everyone beside the curated entries; who added it is not kept.
// Server only.

import { getD1 } from "@/lib/d1";
import type { D1Like } from "@/lib/d1/types";
import { CATALOGUE, bookKey, type CatalogueBook } from "./catalogue";
import { newSlug } from "./slug";

export interface SharedStore {
  list(): Promise<CatalogueBook[]>;
  /** The entry for a resolver link key (one work, one entry). */
  byLink(link: string): Promise<CatalogueBook | null>;
  byKey(lang: string, slug: string): Promise<CatalogueBook | null>;
  /** Add an entry for `link`, or answer the one already there; its slug is made free first. */
  add(link: string, book: CatalogueBook): Promise<CatalogueBook>;
}

/** An entry read back from storage, only when it has the shape the pages rely on. */
export function parseEntry(json: string): CatalogueBook | null {
  try {
    const b = JSON.parse(json) as CatalogueBook;
    if (
      typeof b?.slug === "string" &&
      typeof b.lang === "string" &&
      typeof b.title === "string" &&
      typeof b.author === "string" &&
      typeof b.workCountry === "string" &&
      Number.isInteger(b.firstPublicationYear) &&
      Array.isArray(b.creators) &&
      b.creators.every((c) => typeof c?.name === "string" && Number.isInteger(c.deathYear)) &&
      typeof b.source?.file === "string" &&
      typeof b.source?.page === "string"
    )
      return { ...b, level: typeof b.level === "string" ? b.level : "" };
  } catch {
    // not an entry
  }
  return null;
}

type Db = Pick<D1Like, "prepare">;

export function d1SharedStore(db: Db = getD1() as unknown as Db): SharedStore {
  const one = async (sql: string, ...args: unknown[]) => {
    const row = await db
      .prepare(sql)
      .bind(...args)
      .first<{ entry: string }>();
    return row ? parseEntry(row.entry) : null;
  };
  return {
    async list() {
      const { results } = await db
        .prepare("SELECT entry FROM shared_books ORDER BY created_at ASC, rowid ASC LIMIT 2000")
        .all<{ entry: string }>();
      return (results ?? []).map((r) => parseEntry(r.entry)).filter((b): b is CatalogueBook => !!b);
    },
    byLink: (link) => one("SELECT entry FROM shared_books WHERE link = ?", link),
    byKey: (lang, slug) =>
      one("SELECT entry FROM shared_books WHERE lang = ? AND slug = ?", lang, slug),
    async add(link, book) {
      const prev = await one("SELECT entry FROM shared_books WHERE link = ?", link);
      if (prev) return prev;
      const { results } = await db
        .prepare("SELECT slug FROM shared_books WHERE lang = ?")
        .bind(book.lang)
        .all<{ slug: string }>();
      const taken = new Set([
        ...CATALOGUE.filter((b) => b.lang === book.lang).map((b) => b.slug),
        ...(results ?? []).map((r) => r.slug),
      ]);
      const slug = taken.has(book.slug)
        ? newSlug(book.title, taken, [book.author, String(book.firstPublicationYear), link])
        : book.slug;
      if (!slug) throw new Error("books: no free slug");
      const entry = { ...book, slug };
      await db
        .prepare(
          `INSERT INTO shared_books (lang, slug, link, entry, created_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT DO NOTHING`,
        )
        .bind(entry.lang, entry.slug, link, JSON.stringify(entry), new Date().toISOString())
        .run();
      // Another import may have added the same work (or slug) a moment before.
      return (await one("SELECT entry FROM shared_books WHERE link = ?", link)) ?? entry;
    },
  };
}

/** Curated entries first, then the shared ones (a shared key never shadows a curated one). */
export function mergeCatalogue(shared: CatalogueBook[], curated = CATALOGUE): CatalogueBook[] {
  const keys = new Set(curated.map(bookKey));
  return [...curated, ...shared.filter((b) => !keys.has(bookKey(b)))];
}
