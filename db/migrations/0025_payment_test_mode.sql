-- Stripe test mode (lib/payments/stripe.ts, stripeMode): a pass paid with a
-- test card is credited to the owner only, and its `payment` row says so, so
-- test passes never count as revenue or get mistaken for real ones.
ALTER TABLE payment ADD COLUMN testMode INTEGER NOT NULL DEFAULT 0;
