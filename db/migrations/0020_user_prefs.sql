-- Preferences that follow the account (docs/prefs-sync.md): one row per
-- "<store>.<field>" key of lib/prefs/schema.ts, its JSON value, and the HLC of
-- the write that set it (per-field last-write-wins). `updated_ms` is the
-- server's clock at the write and the `?since=` cursor of GET /api/prefs —
-- client HLCs are not, since a device with a slow clock would hide its rows.
-- Deleting the user deletes the rows (ON DELETE CASCADE).
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id     TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  hlc_ts      INTEGER NOT NULL,
  hlc_counter INTEGER NOT NULL,
  device_id   TEXT NOT NULL,
  updated_ms  INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE INDEX IF NOT EXISTS idx_user_prefs_updated ON user_prefs(user_id, updated_ms);
