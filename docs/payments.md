# Payments — prepaid Pro passes

Pro is sold as **prepaid passes**, not subscriptions: a one-time Stripe
Checkout payment that pushes `user.proEndsAt` forward (stacking on Pro that is
still running). One-time because on Stripe, Alipay and WeChat Pay take
one-time payments only, and they are the reason for this. The catalog (1 month
¥600, 12 months ¥5,000) is `lib/payments/passes.ts`; prices are JPY because the
account settles in JPY.

## Flow

1. `/membership` asks `GET /api/payments/checkout` whether passes are on sale
   and, if so, shows buy buttons instead of "Contact us".
2. `POST /api/payments/checkout {passId}` creates a Checkout Session (card,
   Alipay, WeChat Pay) carrying `userId` and `passId` in its metadata, and the
   page redirects to it.
3. Stripe pushes `checkout.session.completed` (or
   `checkout.session.async_payment_succeeded`) to
   `POST /api/payments/stripe-webhook`. The signature is checked with Web
   Crypto (`lib/payments/stripe.ts`), then `lib/payments/fulfil.ts` writes a
   `payment` row (keyed by the session id, `db/migrations/0013_payments.sql`)
   and the new `proEndsAt` in one D1 batch. A redelivered event is a no-op.

No Stripe SDK: a fetch call and an HMAC are all it needs, and nothing
Node-only reaches the Worker. D1 only — on the Mongo backend the routes 503.

## Turning it on

Off until both secrets exist on the Worker:

```bash
bunx wrangler secret put STRIPE_SECRET_KEY       # sk_test_… / sk_live_…
bunx wrangler secret put STRIPE_WEBHOOK_SECRET   # whsec_… of the endpoint below
```

In the Stripe Dashboard:

- **Settings → Payment methods**: enable Alipay and WeChat Pay.
  `STRIPE_PAYMENT_METHODS` (comma-separated) overrides the offered list if one
  is not enabled yet; Checkout errors on a method the account lacks.
- **Developers → Webhooks**: endpoint
  `https://lianki.com/api/payments/stripe-webhook`, events
  `checkout.session.completed` and `checkout.session.async_payment_succeeded`.

Before live keys: a 特定商取引法 page, terms and privacy policy (Stripe Japan's
review asks for them), and the owner's 資格外活動許可.

## Known gaps

- WeChat Pay on Stripe shows a QR code even on phones, and does not work inside
  WeChat's in-app browser.
- No refunds UI: refund in the Dashboard and shorten `proEndsAt` by hand.

## Invites and gift codes

Rules (owner, 2026-10-29) live in `lib/referrals/rules.ts`; the D1 side in
`lib/referrals/store.ts`, tables in `db/migrations/0014_referrals.sql`.

- **Invite link** `lianki.com/i/CODE`: one code per user, made on first view
  of `/membership`. The route leaves an httpOnly `lk_invite` cookie (30 days)
  and sends the visitor to sign in; the app layout renders `InviteClaim` for a
  signed-in user with that cookie, which POSTs `/api/invite` to claim it.
- **Invitee**: +30 trial days (90 → 120). Only accounts at most 72 h old can
  be invited, and only once.
- **Inviter**: +30 Pro days when the invitee is _active_ (reviewed — page cards
  or words — on 7 distinct UTC days within 30 days of the invite), +30 more on
  the invitee's first pass. At most `YEARLY_CAP_DAYS` (365, provisional) per
  rolling year; a capped reward is still recorded (0 days) so it settles.
- **When it is checked**: no timers. Activation is settled when the invitee
  reads `/api/membership/status` or the inviter opens `/membership`
  (`GET /api/invite`); the purchase bonus in the Stripe webhook.
- **Gift codes**: the owner makes them at `/dev/gift-codes` (N days × M uses,
  optional expiry); anyone redeems on `/membership`, once per code. Not
  counted against the invite cap.

Every reward is a `membership_grant` row with UNIQUE (reason, refId), so each
is given once however often the checks run.
