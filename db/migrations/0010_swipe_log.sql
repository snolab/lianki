-- Swipe telemetry from /words on touch: how far and how fast people swipe,
-- and what it graded — the data to tune lib/words/swipe.ts by. One row per
-- swipe; the owner asked for it to be collected without a button.
CREATE TABLE IF NOT EXISTS swipe_log (
  email TEXT NOT NULL,
  at TEXT NOT NULL,
  finger REAL NOT NULL,      -- finger travel, px (+ right)
  v REAL NOT NULL,           -- release velocity, px/ms
  projected REAL NOT NULL,   -- where the row would rest, px
  rating INTEGER,            -- 1–4, or NULL when it graded nothing
  a REAL NOT NULL,           -- the row height the tiers were scaled by
  params TEXT                -- the tuning in force (decay, resist, strong)
);
CREATE INDEX IF NOT EXISTS swipe_log_email_at ON swipe_log (email, at);
