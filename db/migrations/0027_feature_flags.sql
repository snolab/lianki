-- Owner-controlled feature flags (lib/flags.ts registry, lib/flags-store.ts
-- reads and writes, /dev/flags toggles them). docs/feature-flags.md.
--
-- A key that has no row here is at its registry default, which is always OFF.
-- Only keys in the registry are ever written; a row for a key the registry no
-- longer knows is ignored when read.
CREATE TABLE IF NOT EXISTS feature_flags (
  key        TEXT PRIMARY KEY NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

-- Every change, append-only: who flipped which flag, to what, and when. Written
-- in the same batch as the feature_flags row, so the two never disagree.
CREATE TABLE IF NOT EXISTS feature_flag_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  key     TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  at      TEXT NOT NULL,
  by      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feature_flag_log_at ON feature_flag_log(at);
