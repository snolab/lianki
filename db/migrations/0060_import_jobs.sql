-- Import jobs (docs/import-material.md): one row per imported file or paste.
-- M1 runs a word-list job inline in its request (queued → writing → done |
-- failed within one call); later slices hand jobs to a queue consumer and add
-- 'reading' and 'waiting-user'. Content is never stored here: only the name,
-- the outcome counts in `note` (JSON) and what the job made (`result_ref`,
-- a /words list id for kind 'wordlist').
CREATE TABLE IF NOT EXISTS import_jobs (
  id          TEXT PRIMARY KEY,           -- random UUID
  email       TEXT NOT NULL,              -- the importer (word lists are keyed by email)
  kind        TEXT NOT NULL,              -- 'wordlist'
  name        TEXT NOT NULL,              -- file name or "Pasted list", display only
  status      TEXT NOT NULL,              -- queued | reading | waiting-user | writing | done | failed
  note        TEXT,                       -- JSON counts when done; a short reason when failed
  result_ref  TEXT,                       -- the list made (word_lists.id)
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS import_jobs_email ON import_jobs (email, created_at);
