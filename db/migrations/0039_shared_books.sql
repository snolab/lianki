-- Books added to the shared /books catalogue by a confirmed public-domain
-- import from a pasted link or a library search (docs/books-plan.md, "Paste a
-- link, or search the libraries"). One row per work: `entry` is the catalogue
-- entry (lib/books/catalogue.ts CatalogueBook) as JSON, `page` the source's own
-- page (one work, one row), `link` the resolver's key for it. Who added it and
-- when is not shown; created_at only orders the list.
CREATE TABLE IF NOT EXISTS shared_books (
  lang       TEXT NOT NULL,
  slug       TEXT NOT NULL,
  link       TEXT NOT NULL UNIQUE,
  entry      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (lang, slug)
);
CREATE INDEX IF NOT EXISTS idx_shared_books_created ON shared_books (created_at);
