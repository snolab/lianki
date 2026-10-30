-- The node tree: plans, todos, notes, study sessions — everything is a node.
-- Design: docs/calendar-plan.md (section 2). Code: lib/repos/nodesD1.ts.
--
-- There is no type column on purpose: what a node is for lives in `tags`
-- (a JSON array) and free-form `fields` (a JSON object), so a new use needs no
-- migration. Conventions per tag are in lib/tree/tags.ts. A field that gets
-- hot enough to need an index becomes a VIRTUAL generated column + index.
--
-- Keyed by user_id (like `preferences`), not email. Times are UTC ISO 8601
-- TEXT. Deletes are soft (deleted_at), per docs/sync-merge-rules.md.

CREATE TABLE IF NOT EXISTS nodes (
  id         TEXT PRIMARY KEY NOT NULL,
  user_id    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  parent_id  TEXT,                        -- NULL = a root
  slug       TEXT,                        -- optional; addressable by path when set
  title      TEXT NOT NULL,
  status     TEXT,                        -- open | doing | blocked | done | dropped, or NULL
  tags       TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings
  fields     TEXT NOT NULL DEFAULT '{}',  -- JSON object, free-form
  sort       REAL NOT NULL DEFAULT 0,
  version    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_nodes_children ON nodes(user_id, parent_id, sort);
-- A slug is unique among its live siblings (roots share the '' parent).
CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_slug
  ON nodes(user_id, COALESCE(parent_id, ''), slug)
  WHERE slug IS NOT NULL AND deleted_at IS NULL;

-- The time facet. A node is "a calendar block" exactly when it has a row here;
-- the table is an index for range queries, not a type.
CREATE TABLE IF NOT EXISTS node_times (
  node_id         TEXT PRIMARY KEY NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL,
  start_at        TEXT NOT NULL,          -- UTC
  end_at          TEXT NOT NULL,          -- UTC
  tz              TEXT NOT NULL,          -- IANA zone it was planned in; "UTC" when unknown
  rrule           TEXT,                   -- RFC 5545 subset
  original_start  TEXT,                   -- on an occurrence child: which instance of its parent series
  google_event_id TEXT,
  google_etag     TEXT
);
CREATE INDEX IF NOT EXISTS idx_node_times_range ON node_times(user_id, start_at);

-- One applied group of edits: the change log the user reads, and the undo record.
-- The partner writes directly (owner, 2026-10-31), so a row starts as applied.
CREATE TABLE IF NOT EXISTS changesets (
  id         TEXT PRIMARY KEY NOT NULL,
  user_id    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  summary    TEXT NOT NULL,
  ops        TEXT NOT NULL,               -- JSON: NodeOp[]
  inverse    TEXT NOT NULL,               -- JSON: NodeOp[] that undo it
  by         TEXT NOT NULL,               -- "user" | "agent:<name>" | "google"
  status     TEXT NOT NULL,               -- applied | undone
  created_at TEXT NOT NULL,
  undone_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_changesets_user ON changesets(user_id, created_at);

-- Append-only change log per user: feeds the subscription hub and lets a
-- reconnecting subscriber resume by seq. Ids and types only, never titles.
CREATE TABLE IF NOT EXISTS node_events (
  user_id       TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  node_id       TEXT NOT NULL,
  type          TEXT NOT NULL,            -- created | updated | moved | deleted
  ancestors     TEXT NOT NULL,            -- JSON id chain, root first (excluding the node)
  old_ancestors TEXT,                     -- on a move: the chain before it
  changeset_id  TEXT,
  by            TEXT NOT NULL,
  at            TEXT NOT NULL,
  PRIMARY KEY (user_id, seq)
);

-- The user's IANA time zone. NULL = unknown: Lianki then shows UTC, written
-- out (2026-10-31T09:00Z), and never guesses a zone.
ALTER TABLE preferences ADD COLUMN time_zone TEXT;
