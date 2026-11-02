-- Test-mode payments (Stripe: lib/payments/stripe.ts stripeMode; KOMOJU:
-- lib/payments/providers/komoju.ts komojuMode). A test card only ever reaches
-- the owner's account, and what it pays for is kept apart from real money
-- (test top-ups: 0026_credit_test_ledger.sql).

-- A pass paid by Stripe Checkout in test mode: its `payment` row says so.
ALTER TABLE payment ADD COLUMN testMode INTEGER NOT NULL DEFAULT 0;
