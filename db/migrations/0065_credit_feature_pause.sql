-- A paid feature paused for everyone after a call cost more than its hold
-- (lib/payments/metered.ts; docs/payments.md, "What costs credits"). Neither
-- side eats an overage: the call that showed it is settled at its hold, and
-- the feature stops until the price table (lib/payments/prices.ts,
-- PRICES_VERSION) is updated and deployed — a pause only applies while
-- `version` is the table's current version. No user data.
CREATE TABLE IF NOT EXISTS credit_feature_pause (
  feature   TEXT PRIMARY KEY NOT NULL,
  version   TEXT NOT NULL,
  usd       REAL NOT NULL,   -- what the call that showed it cost (our price)
  holdUsd   REAL NOT NULL,   -- what was held for it
  createdAt TEXT NOT NULL
);
