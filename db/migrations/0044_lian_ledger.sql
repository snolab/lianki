-- The study ledger (docs/lian.md, lib/lian/anchor.ts, packages/lian): each
-- day's study_day rows become a Merkle tree of salted leaves, and the day's
-- anchor chains its root to the day before. Written once by the daily cron;
-- anchors and leaves are append-only (the triggers below refuse an update or
-- a delete), so a day already anchored is never rewritten.

-- A per-user random secret that makes a leaf meaningless to anyone but that
-- user. Never public; handed only to its own user with their proof.
CREATE TABLE IF NOT EXISTS lian_salt (
  user_id    TEXT PRIMARY KEY,
  salt       TEXT NOT NULL,     -- 32 random bytes, hex
  created_at TEXT NOT NULL
) WITHOUT ROWID;

-- One row per day, the chain. chain_hash = H(version ‖ day ‖ merkle_root ‖ prev).
CREATE TABLE IF NOT EXISTS lian_anchor (
  day         TEXT PRIMARY KEY,  -- YYYY-MM-DD, the study_day label
  version     INTEGER NOT NULL,
  merkle_root TEXT NOT NULL,
  prev_hash   TEXT NOT NULL,     -- the day before's chain_hash (zeros on the first day)
  chain_hash  TEXT NOT NULL UNIQUE,
  leaf_count  INTEGER NOT NULL,
  created_at  TEXT NOT NULL
) WITHOUT ROWID;

-- A day's leaves in tree order (sorted by leaf_hash). `summary` is the
-- canonical JSON of the counts the leaf commits to, as they were at anchoring.
CREATE TABLE IF NOT EXISTS lian_leaf (
  day       TEXT NOT NULL,
  idx       INTEGER NOT NULL,
  user_id   TEXT NOT NULL,
  leaf_hash TEXT NOT NULL,
  summary   TEXT NOT NULL,
  PRIMARY KEY (day, idx),
  UNIQUE (day, user_id)
) WITHOUT ROWID;

-- OpenTimestamps receipts of a chain hash, made at milestones by the owner
-- (scripts/lian/timestamp.ts). The .ots file is in R2 at r2_key; `upgrade`
-- rewrites it once a calendar has the Bitcoin path.
CREATE TABLE IF NOT EXISTS lian_timestamp (
  day         TEXT PRIMARY KEY,
  chain_hash  TEXT NOT NULL,
  r2_key      TEXT NOT NULL,
  calendars   TEXT NOT NULL,     -- JSON array of calendars that answered
  status      TEXT NOT NULL CHECK (status IN ('pending', 'bitcoin')),
  btc_height  INTEGER,
  created_at  TEXT NOT NULL,
  upgraded_at TEXT
) WITHOUT ROWID;

CREATE TRIGGER IF NOT EXISTS lian_anchor_no_update BEFORE UPDATE ON lian_anchor
BEGIN
  SELECT RAISE(ABORT, 'lian_anchor is append-only');
END;
CREATE TRIGGER IF NOT EXISTS lian_anchor_no_delete BEFORE DELETE ON lian_anchor
BEGIN
  SELECT RAISE(ABORT, 'lian_anchor is append-only');
END;
CREATE TRIGGER IF NOT EXISTS lian_leaf_no_update BEFORE UPDATE ON lian_leaf
BEGIN
  SELECT RAISE(ABORT, 'lian_leaf is append-only');
END;
CREATE TRIGGER IF NOT EXISTS lian_leaf_no_delete BEFORE DELETE ON lian_leaf
BEGIN
  SELECT RAISE(ABORT, 'lian_leaf is append-only');
END;
