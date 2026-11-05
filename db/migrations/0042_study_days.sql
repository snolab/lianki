-- Study days (lib/study-days.ts, docs/levels.md): the daily rollup learner
-- levels count. One row per user per local day, written by the server when it
-- records a qualifying review (on screen at least human reaction time), on
-- the day of the server's clock in the time zone Cloudflare places the
-- request in — a back-dated client clock or an offline review sent later
-- cannot add a day. Many reviews in a day are still one row.
CREATE TABLE IF NOT EXISTS study_day (
  email    TEXT NOT NULL,
  day      TEXT NOT NULL,      -- YYYY-MM-DD, local to `tz`
  tz       TEXT NOT NULL,      -- IANA zone the day was cut in
  first_at TEXT NOT NULL,      -- server time (ISO) of the day's first qualifying review
  reviews  INTEGER NOT NULL,   -- qualifying reviews that day
  PRIMARY KEY (email, day)
) WITHOUT ROWID;
