-- Files a user uploads through the Import panel's "Any file" (docs/import-material.md,
-- "Any file: stored, not processed"): the same R2 objects and rows as the chat
-- inbox (0035_inbox.sql, lib/inbox/), told apart by `source` — the design's
-- open question 1, "one table, a source column". 'chat' = the chat's
-- attachments (every row before this migration), 'import' = the Import panel.
-- Usage (inbox_usage) and the caps are shared: one user, one storage.
ALTER TABLE inbox_item ADD COLUMN source TEXT NOT NULL DEFAULT 'chat';
CREATE INDEX IF NOT EXISTS inbox_item_owner_source ON inbox_item (owner_id, source, created_ms);
