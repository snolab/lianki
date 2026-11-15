-- The spend alert (docs/payments.md, "Spend alert"): a running total of what
-- the AI/TTS/STT calls cost us since it shipped, and the last whole step
-- (partner.spendAlertStepUsd) announced in the owner's thread, one row per
-- counter: 'site' for the whole site, 'user:<id>' for one account (announced
-- only for an account holding admin or dev). Amounts in millionths of a USD,
-- as cost_ledger.usd_micro. `last_micro` only moves up, by a guarded UPDATE:
-- a step is announced once however many calls cross it together.
CREATE TABLE IF NOT EXISTS spend_alert (
  scope       TEXT PRIMARY KEY,
  total_micro REAL NOT NULL DEFAULT 0 CHECK (total_micro >= 0),
  last_micro  REAL NOT NULL DEFAULT 0 CHECK (last_micro >= 0),
  updated_at  TEXT NOT NULL
);
