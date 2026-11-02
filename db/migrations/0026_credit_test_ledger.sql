-- Test-mode top-ups (Stripe and KOMOJU; lib/payments/credits-store.ts,
-- creditTestTopup).
--
-- Test top-ups go here, never into credit_ledger / credit_balance: test credits
-- cannot be spent (no pass, no inviter bonus) and never become real balance,
-- not even after a provider is switched to live. The balance is the SUM; it is
-- for display only. UNIQUE (reason, refId) makes each entry once-only, like
-- the real ledger (refId `<provider>:<paymentId>`; a refund `topup:<that>`).
CREATE TABLE IF NOT EXISTS credit_test_ledger (
  id        TEXT PRIMARY KEY NOT NULL,
  userId    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  amount    INTEGER NOT NULL CHECK (amount <> 0),   -- JPY, signed
  reason    TEXT NOT NULL CHECK (reason IN ('topup', 'refund')),
  refId     TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  UNIQUE (reason, refId)
);
CREATE INDEX IF NOT EXISTS idx_credit_test_ledger_user ON credit_test_ledger(userId, createdAt);
