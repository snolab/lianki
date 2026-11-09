-- /vibe's translations (docs/vibe.md, "Translations"): private with their doc, so
-- not in the shared read_translation, and gone when the doc goes. One row a line
-- and language, which is what keeps a line from being charged twice.
CREATE TABLE IF NOT EXISTS vibe_translation (
  doc_id     TEXT NOT NULL REFERENCES vibe_doc(id) ON DELETE CASCADE,
  target     TEXT NOT NULL,
  line       TEXT NOT NULL,
  out        TEXT NOT NULL,
  model      TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  PRIMARY KEY (doc_id, target, line)
);
