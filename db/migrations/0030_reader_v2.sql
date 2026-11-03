-- Reader v2 (docs/books-plan.md, "Review units"): sentences are the atomic
-- review unit. Sentence ids are derived, not stored as a table:
-- "<book hash>:<line>.<index>" (lib/read/units.ts). Every table is keyed by the
-- reader's user_id (as read_materials), and every query filters on it.

-- The book hash (SHA-256 of the plain lines, 16 hex), filled at import and
-- backfilled on next open: finds the same text imported again, and the reader
-- rows of a book.
ALTER TABLE read_materials ADD COLUMN content_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_read_materials_user_hash ON read_materials (user_id, content_hash);

-- FSRS state per user per graded sentence (ts-fsrs Card JSON).
CREATE TABLE IF NOT EXISTS read_sentence_cards (
  user_id     TEXT NOT NULL,
  sid         TEXT NOT NULL,          -- "<book hash>:<line>.<index>"
  book_hash   TEXT NOT NULL,
  line        INTEGER NOT NULL,
  idx         INTEGER NOT NULL,
  text_key    TEXT NOT NULL,          -- short hash of the sentence text (remap guard)
  card        TEXT NOT NULL,          -- ts-fsrs Card, JSON, ISO dates
  due         TEXT NOT NULL,
  last_rating INTEGER NOT NULL CHECK (last_rating BETWEEN 1 AND 4),
  rev         TEXT NOT NULL,          -- the read (read_reviews.id) that wrote it: the concurrency token
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, sid)
);
CREATE INDEX IF NOT EXISTS idx_read_sentence_cards_book ON read_sentence_cards (user_id, book_hash, line);
CREATE INDEX IF NOT EXISTS idx_read_sentence_cards_due ON read_sentence_cards (user_id, book_hash, due);

-- One row per swipe: what was graded, how, and how long it was read first.
-- The history of an item, and the data its time bounds come from.
CREATE TABLE IF NOT EXISTS read_reviews (
  id          TEXT NOT NULL,              -- client id (idempotent retries) or a UUID
  user_id     TEXT NOT NULL,
  material_id TEXT NOT NULL,
  book_hash   TEXT NOT NULL,
  lang        TEXT NOT NULL,
  granularity TEXT NOT NULL CHECK (granularity IN ('sentence', 'paragraph', 'time')),
  rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 4),
  first_sid   TEXT NOT NULL,
  last_sid    TEXT NOT NULL,
  line_from   INTEGER NOT NULL,
  line_to     INTEGER NOT NULL,
  count       INTEGER NOT NULL CHECK (count > 0),  -- 0 = a stale read (lib/read/reader-store.ts): refused
  words       INTEGER NOT NULL,           -- reading load of the item
  dwell_ms    INTEGER,                    -- shown → swiped, when sent
  at          TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_read_reviews_book ON read_reviews (user_id, book_hash, line_from);
CREATE INDEX IF NOT EXISTS idx_read_reviews_lang ON read_reviews (user_id, lang, at);

-- Reading position per user per material: anchor (newest client time wins)
-- and the high-water line (only grows).
CREATE TABLE IF NOT EXISTS read_progress (
  user_id     TEXT NOT NULL,
  material_id TEXT NOT NULL,
  line        INTEGER NOT NULL,
  anchor_offset REAL NOT NULL,
  anchor_at   TEXT NOT NULL,
  high_line   INTEGER,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, material_id)
);

-- Exposure log: words seen in context. Never changes a word's FSRS state.
-- Events dedupe resends (one per user, sentence, kind, word, day).
CREATE TABLE IF NOT EXISTS read_exposure_events (
  user_id   TEXT NOT NULL,
  book_hash TEXT NOT NULL,
  sid       TEXT NOT NULL,
  kind      TEXT NOT NULL CHECK (kind IN ('seen', 'lookup', 'select', 'note')),
  word      TEXT NOT NULL DEFAULT '',  -- '' for "seen" (its words are the sentence's)
  day       TEXT NOT NULL,             -- YYYY-MM-DD (UTC)
  at        TEXT NOT NULL,
  batch     TEXT,                      -- the request that inserted it: only it adds to read_exposures
  PRIMARY KEY (user_id, sid, kind, word, day)
);
CREATE INDEX IF NOT EXISTS idx_read_exposure_events_book ON read_exposure_events (user_id, book_hash);
CREATE INDEX IF NOT EXISTS idx_read_exposure_events_batch ON read_exposure_events (user_id, batch);

-- Per word per day: how often seen in context, how often marked not recognised.
CREATE TABLE IF NOT EXISTS read_exposures (
  user_id  TEXT NOT NULL,
  lang     TEXT NOT NULL,
  word     TEXT NOT NULL,             -- normalised (lib/read/words.ts normWord)
  day      TEXT NOT NULL,
  seen     INTEGER NOT NULL DEFAULT 0,
  explicit INTEGER NOT NULL DEFAULT 0,
  last_at  TEXT NOT NULL,
  last_sid TEXT NOT NULL,
  PRIMARY KEY (user_id, lang, word, day)
);
CREATE INDEX IF NOT EXISTS idx_read_exposures_recent ON read_exposures (user_id, lang, last_at);

-- A note per read on an item (or a free note), with its earlier texts.
CREATE TABLE IF NOT EXISTS read_notes (
  id          TEXT PRIMARY KEY NOT NULL,
  user_id     TEXT NOT NULL,
  book_hash   TEXT NOT NULL,
  first_sid   TEXT NOT NULL,
  last_sid    TEXT NOT NULL,
  line_from   INTEGER NOT NULL,
  line_to     INTEGER NOT NULL,
  review_id   TEXT,
  text        TEXT NOT NULL,
  history     TEXT NOT NULL DEFAULT '[]',  -- JSON [{text, at}], oldest first
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_read_notes_book ON read_notes (user_id, book_hash, line_from);
CREATE INDEX IF NOT EXISTS idx_read_notes_review ON read_notes (user_id, review_id);
