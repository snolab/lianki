-- Per-video watch-time tracking (language-input hours).
--
-- Deliberately a separate table rather than a column on fsrs_notes: card_due on
-- that table drives the review queue, so recording watch time there would enqueue
-- a review card for every video the user merely plays. Tracking stays orthogonal
-- to scheduling; a stats page joins on (email, url) when it wants both.
--
-- `stats` is the grow-only per-device CRDT from @lianki/core (packages/core/src/
-- watchStats.ts). wall / lang / last_seen duplicate values derivable from that
-- JSON so "top videos" and "hours per language" stay plain indexed SQL instead of
-- a full-table JSON scan.
CREATE TABLE IF NOT EXISTS watch_stats (
  email     TEXT NOT NULL,
  url       TEXT NOT NULL,               -- normalizeUrl()'d, matches fsrs_notes.url
  stats     TEXT NOT NULL DEFAULT '{}',  -- JSON: WatchStats
  wall      INTEGER NOT NULL DEFAULT 0,  -- denormalized: summed active wall seconds
  media     INTEGER NOT NULL DEFAULT 0,  -- denormalized: summed media seconds
  lang      TEXT,                        -- denormalized: BCP-47 audio language
  title     TEXT,
  last_seen TEXT,                        -- denormalized: ISO 8601 of latest activity
  PRIMARY KEY (email, url)
);
CREATE INDEX IF NOT EXISTS idx_watch_stats_wall ON watch_stats(email, wall DESC);
CREATE INDEX IF NOT EXISTS idx_watch_stats_lang ON watch_stats(email, lang);
CREATE INDEX IF NOT EXISTS idx_watch_stats_last ON watch_stats(email, last_seen DESC);
