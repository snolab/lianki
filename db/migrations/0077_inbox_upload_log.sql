-- Keep rolling upload quota after a file is deleted; names/content are not logged.
-- This is local/account metadata, not a public activity log.
CREATE TABLE IF NOT EXISTS inbox_upload_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size > 0),
  created_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS inbox_upload_log_user ON inbox_upload_log (user_id, created_ms);
