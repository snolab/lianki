-- Login-streak bonus (lib/payments/login-streak-store.ts; docs/payments.md,
-- "Login-streak bonus"): one row per account with the streak as of the last
-- day that counted. A day counts when the server records a qualifying
-- learning action (the study_day write, lib/study-days.ts), cut in the
-- account's home time zone. The grant itself is a credit_ledger row, reason
-- 'gift', refId 'streak:<userId>:<day>' — UNIQUE (reason, refId), so a day
-- is paid once however often it is tried.
CREATE TABLE IF NOT EXISTS login_streak (
  userId    TEXT PRIMARY KEY,
  day       TEXT NOT NULL,      -- YYYY-MM-DD of the last day that counted, local to `tz`
  tz        TEXT NOT NULL,      -- IANA zone the day was cut in
  streak    INTEGER NOT NULL,   -- consecutive days as of `day` (after the miss rule)
  updatedAt TEXT NOT NULL
) WITHOUT ROWID;
