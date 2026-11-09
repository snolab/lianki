-- "Words with AI" (lib/import/ai-convert.ts): each paid chunk's answer, per
-- user and stored file, keyed by the chunk's hash. A conversion that stopped
-- for want of credits resumes after a top-up: the finished chunks are reused,
-- only the rest is paid. Rows go with the file (lib/import/files.ts delete).
-- Not a guarantee: the page shows the recommended balance up front.
CREATE TABLE IF NOT EXISTS ai_chunk_cache (
  user_id    TEXT NOT NULL,
  file_id    TEXT NOT NULL,
  chunk_hash TEXT NOT NULL,   -- sha256 of the call's model, prompt and material
  rows_json  TEXT NOT NULL,   -- the chunk's parsed rows, [{word, meaning, example}]
  created_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, file_id, chunk_hash)
);
