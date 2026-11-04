-- Meanings generated for words our decks have no gloss for (lib/read/gloss.ts):
-- a dictionary shared by everyone, not personal data — a word and its gloss,
-- keyed by language and headword. Generated once per word, then read from
-- here, so the same word is never generated (or paid for) twice.
CREATE TABLE IF NOT EXISTS word_gloss (
  lang       TEXT NOT NULL,
  term       TEXT NOT NULL,      -- the headword (lowercase, NFC), as the book's word folds to it
  back       TEXT NOT NULL,      -- the meaning, in the decks' gloss style
  model      TEXT NOT NULL,      -- what wrote it
  created_at TEXT NOT NULL,
  PRIMARY KEY (lang, term)
);
