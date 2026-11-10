-- What each account's free calls cost us (docs/payments.md, "Cost ledger").
-- The free features (word read-aloud, the microphone: FREE_FEATURES in
-- lib/payments/paid-calls.ts) charge the user nothing, but their provider cost
-- is booked here per account, so /dev/costs can show who consumed what next to
-- what the paid features charged (credit_ai_charge). Users never see it.
--
-- One row per served call: the account id ('' for a guest), the feature, the
-- provider cost in millionths of a USD (REAL: a MeloTTS clip is a few
-- millionths, so fractions are kept), its units (audio seconds for speech to
-- text, characters for speech), and the day it happened (JST, YYYY-MM-DD).
-- No text, no audio, no email: only the account id.
CREATE TABLE IF NOT EXISTS cost_ledger (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   TEXT NOT NULL,
  feature   TEXT NOT NULL,
  usd_micro REAL NOT NULL CHECK (usd_micro >= 0),
  units     REAL NOT NULL DEFAULT 0,
  day       TEXT NOT NULL,
  at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cost_ledger_day_user ON cost_ledger(day, user_id);
CREATE INDEX IF NOT EXISTS idx_cost_ledger_feature ON cost_ledger(feature, day);

-- /dev/costs reads the paid side by settle time.
CREATE INDEX IF NOT EXISTS idx_credit_ai_charge_settled ON credit_ai_charge(settledAt);
