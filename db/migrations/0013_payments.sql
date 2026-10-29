-- Prepaid Pro passes (lib/payments). One row per paid Stripe Checkout Session:
-- the session id is the primary key, so a webhook Stripe redelivers (it
-- retries until it gets a 2xx) extends proEndsAt once, not twice.
--
-- amount is in the currency's minor unit as Stripe reports it (JPY has none:
CREATE TABLE IF NOT EXISTS payment (
  id            TEXT PRIMARY KEY NOT NULL,
  userId        TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  passId        TEXT NOT NULL,
  days          INTEGER NOT NULL,
  amount        INTEGER NOT NULL,
  currency      TEXT NOT NULL,
  proEndsAt     TEXT NOT NULL,   -- the expiry this payment set
  createdAt     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payment_userId ON payment(userId);
