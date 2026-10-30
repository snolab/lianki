-- One-time changes to a user's word-list tree, recorded so they run once and
-- can be undone (lib/words/lang-groups.ts, docs/words-language-groups.md).
--
-- name:      which change, e.g. "group-by-language-v1"
-- token:     the request that claimed it; only that request applies the change,
--            so two devices loading at once cannot both run it
-- undo:      JSON (GroupingUndo): the tree before and after, groups created,
--            lists moved
-- undone_at: set by "undo grouping"; the row stays, so it never reruns
CREATE TABLE IF NOT EXISTS word_list_migrations (
  email      TEXT NOT NULL,
  name       TEXT NOT NULL,
  token      TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  undo       TEXT NOT NULL DEFAULT '{}',
  undone_at  TEXT,
  PRIMARY KEY (email, name)
);
