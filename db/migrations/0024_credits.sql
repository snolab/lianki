-- Prepaid credits — a wallet balance in JPY (lib/payments/credits*.ts).
--
-- credit_ledger is append-only: + for a top-up, gift, sponsor credit or refund,
-- − for a pass bought with the balance. UNIQUE (reason, refId) makes every
-- entry once-only: a redelivered top-up webhook (refId `stripe:<session id>`),
-- a double-clicked "buy with balance" (refId = the request's idempotency key)
-- or a re-run refund can never apply twice.
CREATE TABLE IF NOT EXISTS credit_ledger (
  id        TEXT PRIMARY KEY NOT NULL,
  userId    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  amount    INTEGER NOT NULL CHECK (amount <> 0),   -- JPY, signed
  reason    TEXT NOT NULL CHECK (reason IN ('topup', 'pass', 'refund', 'gift', 'sponsor', 'adjust')),
  refId     TEXT NOT NULL,
  passId    TEXT,                                    -- reason 'pass' (and its 'refund')
  note      TEXT,
  createdAt TEXT NOT NULL,
  UNIQUE (reason, refId)
);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_user ON credit_ledger(userId, createdAt);

-- The cached sum of a user's ledger, written in the same D1 batch (one
-- transaction) as every ledger row. The CHECK is the no-negative-balance rule:
-- a spend larger than the balance violates it and rolls the whole batch back,
-- ledger row and Pro extension included. No row = a balance of 0 (the row is
-- created at 0 first, then updated: SQLite checks CHECK before ON CONFLICT).
CREATE TABLE IF NOT EXISTS credit_balance (
  userId    TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  balance   INTEGER NOT NULL CHECK (balance >= 0),
  updatedAt TEXT NOT NULL
);

-- Gift codes may carry credits as well as (or instead of) Pro days.
ALTER TABLE gift_code ADD COLUMN credits INTEGER NOT NULL DEFAULT 0;
