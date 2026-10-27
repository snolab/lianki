-- Word lists: sub-second vocabulary review, apart from the page-card deck.
--
-- Deliberately separate from fsrs_notes. A word list holds thousands of tiny
-- cards reviewed dozens per minute; mixed into fsrs_notes they would bury the
-- page-card queue (/next, the userscript, /list) and skew its stats. They also
-- run on a different rhythm, so each list carries its own FSRS parameters
-- (target retention, minute-level learning steps, max interval, new per day).
--
-- A list built from a catalog file (public/words/<source>.json) does not copy
-- the catalog in: a word gets a word_cards row only when it is first reviewed,
-- and `cursor` is how far into the catalog new words have been introduced.
CREATE TABLE IF NOT EXISTS word_lists (
  email       TEXT NOT NULL,
  id          TEXT NOT NULL,
  name        TEXT NOT NULL,
  lang        TEXT NOT NULL,
  source      TEXT,                       -- catalog list id, e.g. "fr-freq-1"
  cursor      INTEGER NOT NULL DEFAULT 0, -- catalog entries introduced so far
  params      TEXT NOT NULL DEFAULT '{}', -- JSON: WordListParams
  new_day     TEXT,                       -- YYYY-MM-DD that new_today counts
  new_today   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (email, id)
);

CREATE TABLE IF NOT EXISTS word_cards (
  email       TEXT NOT NULL,
  list_id     TEXT NOT NULL,
  term        TEXT NOT NULL,
  reading     TEXT,
  back        TEXT NOT NULL DEFAULT '',
  card        TEXT NOT NULL,              -- JSON: ts-fsrs Card
  card_due    TEXT NOT NULL,              -- denormalized card.due (ISO) for the due index
  reps        INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (email, list_id, term)
);
CREATE INDEX IF NOT EXISTS idx_word_cards_due ON word_cards(email, list_id, card_due);

-- Append-only review log, kept out of the card row so a 5000-word list does not
-- carry 5000 growing JSON arrays. Enough to fit per-list FSRS parameters later.
CREATE TABLE IF NOT EXISTS word_reviews (
  email       TEXT NOT NULL,
  list_id     TEXT NOT NULL,
  term        TEXT NOT NULL,
  rating      INTEGER NOT NULL,
  state       INTEGER NOT NULL,           -- card state before this review
  elapsed_ms  INTEGER,                    -- time the row was on screen, if measured
  reviewed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_word_reviews_list ON word_reviews(email, list_id, reviewed_at);
