-- Imported word lists (/words/import, an Anki .apkg): the words themselves,
-- per user. A catalog list reads its words from public/words/<source>.json;
-- a list with source "anki:<deck id>" reads them from here instead, in
-- `position` order (the order new words are introduced in, as `cursor` counts).
--
-- `key` is the Anki note guid, so importing the same deck again updates each
-- word in place (and renames its card if the word itself changed) rather than
-- adding it twice. New notes are appended, so positions — and the cursor —
-- stay valid.
CREATE TABLE IF NOT EXISTS word_list_entries (
  email      TEXT NOT NULL,
  list_id    TEXT NOT NULL,
  key        TEXT NOT NULL,
  position   INTEGER NOT NULL,
  term       TEXT NOT NULL,
  back       TEXT NOT NULL DEFAULT '',
  reading    TEXT,
  ex         TEXT,
  ex_tr      TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (email, list_id, key)
);
CREATE INDEX IF NOT EXISTS idx_word_list_entries_pos ON word_list_entries(email, list_id, position);
