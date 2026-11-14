-- Sign-up bonus (lib/payments/signup-bonus-store.ts; docs/payments.md,
-- "Sign-up bonus"): a new account gets credits once, for only the first N new
-- accounts of each UTC day (config credits.signupBonusDaily). The grant itself
-- is a credit_ledger row, reason 'gift', refId 'signup:<userId>' — UNIQUE
-- (reason, refId), so an account is paid once however often it is tried.
--
-- One row per UTC day: how many bonuses that day paid. The ledger row is
-- inserted only WHERE granted < cap and the count moves only WHERE EXISTS
-- that very ledger row, in one D1 batch (one transaction), so no two
-- accounts can both be number N.
CREATE TABLE IF NOT EXISTS signup_bonus_day (
  day       TEXT PRIMARY KEY,           -- YYYY-MM-DD, UTC
  granted   INTEGER NOT NULL DEFAULT 0, -- bonuses paid that day
  updatedAt TEXT NOT NULL
) WITHOUT ROWID;

-- When the feature went live: accounts created before it get the bonus once,
-- outside the daily cap, on their next sign-in or wallet read (the lazy
-- backfill, owner 2026-11-15). Recorded by this migration, so it is the
-- moment the schema reached production.
CREATE TABLE IF NOT EXISTS signup_bonus_launch (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  at TEXT NOT NULL                      -- ISO 8601 UTC
);
INSERT OR IGNORE INTO signup_bonus_launch (id, at)
  VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
