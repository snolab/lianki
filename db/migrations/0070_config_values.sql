-- The config store: live values for the numbers, texts and icons the code only
-- holds a default for (lib/config.ts registry, lib/config-store.ts reads and
-- writes, /dev/config edits them). docs/config-store.md.
--
-- A key with no row reads as its registry default. Only registry keys are ever
-- written; a row whose key the registry no longer knows, or whose value fails
-- the key's schema, is ignored when read (the default wins).
CREATE TABLE IF NOT EXISTS config_values (
  key        TEXT PRIMARY KEY NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

-- Every change, append-only: who set which key from what to what, when and
-- why. old_json is NULL when the key was at its default, new_json NULL for a
-- reset to the default. Written in the same batch as the config_values row.
CREATE TABLE IF NOT EXISTS config_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  key      TEXT NOT NULL,
  old_json TEXT,
  new_json TEXT,
  by       TEXT NOT NULL,
  at       TEXT NOT NULL,
  note     TEXT
);
CREATE INDEX IF NOT EXISTS idx_config_log_key ON config_log(key, id);
