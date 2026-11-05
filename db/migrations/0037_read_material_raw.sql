-- The raw text of a polished material (docs/books-plan.md, "Import
-- pipeline"): an AI polish of a raw speech-to-text transcript fixes its
-- punctuation and paragraphs, but the text as imported is never lost. One row
-- per material, written the first time it is polished and never overwritten
-- by a later polish; gone when the material is re-imported from its source
-- (its text is raw again) or deleted.
CREATE TABLE IF NOT EXISTS read_material_raw (
  user_id     TEXT NOT NULL,
  material_id TEXT NOT NULL,
  lines       TEXT NOT NULL,             -- JSON string[], as imported
  content     TEXT NOT NULL,             -- the BookMeta JSON as imported
  created_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, material_id)
);
