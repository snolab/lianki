-- Learning Partner AI replies cost credits (docs/partner-ai.md, "Credits").
--
-- 1. credit_ledger gains the reason 'ai': the reservation taken before a
--    model call (refId `ai:<userId>:<message id>`). What was not used comes
--    back as a 'refund' row with the same refId. SQLite cannot change a CHECK
--    in place, so the table is rebuilt with its rows, columns and index as
--    they were; nothing references it.
PRAGMA defer_foreign_keys = true;

CREATE TABLE credit_ledger_new (
  id        TEXT PRIMARY KEY NOT NULL,
  userId    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  amount    INTEGER NOT NULL CHECK (amount <> 0),   -- credits, signed
  reason    TEXT NOT NULL CHECK (reason IN ('topup', 'pass', 'refund', 'gift', 'sponsor', 'adjust', 'ai')),
  refId     TEXT NOT NULL,
  passId    TEXT,
  note      TEXT,
  createdAt TEXT NOT NULL,
  UNIQUE (reason, refId)
);
INSERT INTO credit_ledger_new (rowid, id, userId, amount, reason, refId, passId, note, createdAt)
  SELECT rowid, id, userId, amount, reason, refId, passId, note, createdAt FROM credit_ledger;
DROP TABLE credit_ledger;
ALTER TABLE credit_ledger_new RENAME TO credit_ledger;
CREATE INDEX IF NOT EXISTS idx_credit_ledger_user ON credit_ledger(userId, createdAt);

-- 2. One row per AI reply (key `<userId>:<message id>`): the reservation
--    debited before the call, then settled once (status pending → settled)
--    with the real cost. The key makes a retried message a no-op, and a
--    pending row older than a few minutes (a crash between reserve and
--    settle) is settled by the next reply's sweep, refunding it in full.
CREATE TABLE IF NOT EXISTS credit_ai_charge (
  key        TEXT PRIMARY KEY NOT NULL,
  userId     TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  reserved   INTEGER NOT NULL CHECK (reserved > 0),  -- whole credits debited first
  status     TEXT NOT NULL CHECK (status IN ('pending', 'settled')),
  costMicro  INTEGER,                                -- real cost, millionths of a credit
  charged    INTEGER,                                -- whole credits kept (reserved − refund)
  settleId   TEXT,
  createdAt  TEXT NOT NULL,
  settledAt  TEXT
);
CREATE INDEX IF NOT EXISTS idx_credit_ai_charge_pending ON credit_ai_charge(status, createdAt);

-- 3. The fraction of a credit a user's replies have used but not yet paid:
--    a reply costs far less than one credit, so the real cost accumulates
--    here and whole credits are kept from the reservation as it crosses one.
CREATE TABLE IF NOT EXISTS credit_ai_carry (
  userId    TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  micro     INTEGER NOT NULL CHECK (micro >= 0)
);
