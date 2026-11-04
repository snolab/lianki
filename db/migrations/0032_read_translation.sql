-- The reader's Translate (lib/read/translate.ts): a text's translation into a
-- language, generated once and then read from here, so the same text and
-- target are never translated (or paid for) twice. Shared by everyone with
-- the same text; the text itself is not stored, only its hash.
CREATE TABLE IF NOT EXISTS read_translation (
  key        TEXT PRIMARY KEY,   -- SHA-256 hex of "<target>\n<normalised text>"
  target     TEXT NOT NULL,      -- BCP 47 code translated into
  out        TEXT NOT NULL,      -- the translation
  model      TEXT NOT NULL,      -- what wrote it
  created_at TEXT NOT NULL
);
