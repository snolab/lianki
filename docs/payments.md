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
2. `POST /api/payments/checkout {passId, turnstileToken}` first passes the
   card-testing guard (5 starts / 10 min per user and IP, Turnstile;
   `lib/payments/checkout-guard.ts`), then creates a Checkout Session (card,
   Alipay, WeChat Pay) carrying `userId` and `passId` in its metadata, with
   3-D Secure requested for cards (`lib/payments/checkout-policy.ts`), and the
   page redirects to it. See [security-measures.md](security-measures.md).
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
- No refunds UI for passes paid by card: refund in the Dashboard and shorten
  `proEndsAt` by hand. Credit-wallet refunds are at `/dev/credits` (below).

## Credits (prepaid wallet)

A wallet balance in JPY, modelled on wallets like renzhe.cloud's: top up once
through any enabled payment method, then spend the balance on passes; a pass
bought with the balance activates at once, with no payment page in between.
Rules in `lib/payments/credits.ts`, D1 side in `lib/payments/credits-store.ts`,
tables in `db/migrations/0017_credits.sql`, UI in
`app/(app)/membership/WalletCard.tsx`.

### Ledger

- `credit_ledger` is append-only: one row per change, amount in JPY signed
  (+ top-up, gift, sponsor, refund to the wallet; − a pass, a reversed
  top-up), reason `topup | pass | refund | gift | sponsor | adjust`, and
  **UNIQUE (reason, refId)** — each entry is once-only.
- `credit_balance` caches the sum. Every ledger row and its balance change are
  written in the **same D1 batch** (one transaction), so the two never
  disagree. `CHECK (balance >= 0)` is the no-negative rule: an overdraft fails
  the UPDATE and rolls back the whole batch, Pro extension included. The
  pre-read balance only shapes the answer; the CHECK is the guard, so two
  concurrent spends cannot both pass (unit test "atomic").
- The row is created at 0 and then updated — not upserted with the delta:
  SQLite checks CHECK on the proposed INSERT row before `ON CONFLICT`.
- refIds: top-up `<provider>:<paymentId>`; pass `<userId>:<client key>` (one
  key per click, so a retried request buys once); refund `pass:<spend refId>`
  or `topup:<top-up refId>`; gift `<code>:<userId>`; admin `admin:<uuid>`.

### Endpoints

| endpoint                                 | does                                                                                                                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/payments/credits`              | balance, the newest 50 entries, top-up limits and the **enabled** providers                                                                                          |
| `POST /api/payments/topup`               | `{amount, provider?, turnstileToken}`, ¥100–¥10,000 whole yen → `{kind:"redirect",url}` or `{kind:"qr",qr}`. Same rate limit + Turnstile as pass checkout           |
| `POST /api/payments/buy-pass`            | `{passId, key}` → 200 `{balance, proEndsAt}`, or **402** `{balance, price, missing}` — the page offers a top-up of exactly `missing` (at least the ¥100 minimum)      |
| `POST /api/payments/webhook/<provider>`  | the provider's webhook; it verifies its own signature, then credits the ledger keyed by provider + paymentId                                                         |
| `POST /api/payments/stripe-webhook`      | Stripe's single endpoint: passes as before, and sessions with `metadata.kind = "topup"` credit the wallet                                                            |
| `GET/POST /api/dev/credits`, `/dev/credits` | owner only (404 otherwise): look a wallet up; add/take credits (`sponsor`/`adjust`/`gift`); refund a credit-bought pass to the wallet; reverse a refunded top-up |

Quick amounts are ¥600, ¥1,200, ¥3,000 and ¥5,000, so they line up with the
passes. A Stripe top-up credits `amount_total` — what was actually paid, JPY
only — not the amount the metadata asked for. Buying a pass with credits also
triggers the inviter's first-pass bonus.

Gift codes can carry credits (`gift_code.credits`) as well as, or instead of,
Pro days; both land in one batch with the `membership_grant` marker, once per
person per code.

### Refunds

- **A pass bought with credits**: `/dev/credits` → "退回余额" returns the
  price to the wallet and takes the pass's days off `proEndsAt` (never before
  now), once.
- **A top-up refunded at the provider** (Stripe Dashboard): `/dev/credits` →
  "撤回充值" takes the credits back. Refused if they were already spent — the
  balance never goes negative; refund the pass first, or settle by hand.
- No refund of unused credits to the user's card yet — see the open question
  below.

### Providers

The wallet is provider-plural (`lib/payments/providers/`). A provider is
listed on `/membership` only when it is **implemented and every one of its
`envKeys` is set** on the Worker.

| id                | kind     | methods                                     | env (secrets)                                  | state       |
| ----------------- | -------- | ------------------------------------------- | ---------------------------------------------- | ----------- |
| `stripe`          | checkout | card, Alipay, WeChat Pay                    | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`   | implemented |
| `komoju`          | checkout | card, konbini, PayPay, Alipay, WeChat Pay   | `KOMOJU_SECRET_KEY`, `KOMOJU_WEBHOOK_SECRET`   | slot        |
| `payjp`           | checkout | card (3-D Secure, checkout-policy.ts)       | `PAYJP_SECRET_KEY`, `PAYJP_WEBHOOK_TOKEN`      | slot        |
| `paddle`          | checkout | card, PayPal, Apple Pay                     | `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`      | slot        |
| `usdt`            | checkout | USDT TRC-20 / ERC-20 (QR)                   | `USDT_GATEWAY_API_KEY`, `USDT_GATEWAY_WEBHOOK_SECRET` | slot |
| `afdian`          | grant    | 爱发电 (Alipay, WeChat Pay)                  | `AFDIAN_USER_ID`, `AFDIAN_API_TOKEN`           | slot        |
| `patreon`         | grant    | Patreon                                     | `PATREON_WEBHOOK_SECRET`                       | slot        |
| `github-sponsors` | grant    | GitHub Sponsors (as credits, not Pro days)  | `GITHUB_SPONSORS_CREDITS`                      | slot        |

`checkout` providers start a payment of an amount the user picks; `grant`
providers have no button — money arrives on another platform and its webhook
credits the wallet as `sponsor`.

#### Adding a provider

1. Write `lib/payments/providers/<id>.ts` exporting a `PaymentProvider`
   (`types.ts`): `createTopup(amount, user, urls)` returns
   `{kind: "redirect", url}` or `{kind: "qr", qr}`; `verifyWebhook(req)` checks
   the provider's signature (Web Crypto, constant time — no Node-only SDKs on
   the Worker) and returns `{status: "paid", paymentId, amount, userId}`, or
   `ignored` / `invalid`. Put `userId` in the provider's metadata when the
   payment is created, and credit the JPY actually paid.
2. Credit only on the provider's "settled" event (konbini and crypto settle
   later than the redirect).
3. Replace its stub in `stubs.ts` with the real module in `index.ts`'s
   `PROVIDERS` (or add a new id to `ProviderId`).
4. Register the webhook at `https://lianki.com/api/payments/webhook/<id>` and
   `bunx wrangler secret put` each of its `envKeys`. It shows up on
   `/membership` once all are set.
5. Card providers must request 3-D Secure (`checkout-policy.ts`), and
   `/api/payments/topup` already runs the rate limit + Turnstile before any
   provider is called.
6. Unit-test its webhook parsing; idempotency comes from the ledger
   (`<id>:<paymentId>`), not from the adapter.

### Open questions (owner)

- **Minimum top-up**: ¥100 now (`TOPUP_MIN`); Stripe's JPY minimum is ¥50.
  Card fees (~3.6%) make tiny top-ups poor value — ¥500 or ¥600 may be better.
- **Expiry**: none (suggested). Note that unexpiring prepaid credits are a
  自家型前払式支払手段 under 資金決済法: no registration, but if the unused
  balance on 3/31 or 9/30 exceeds ¥10M, a 届出 and a deposit of half of it are
  required. Credits valid ≤ 6 months are outside the act.
- **Refunds of unused credits**: 資金決済法 in principle forbids paying back
  前払式支払手段 except when the business stops (or small amounts). The
  refund policy should say unused credits are not refundable except as the law
  requires; passes bought with credits can be refunded to the wallet.

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
- **Gift codes**: the owner makes them at `/dev/gift-codes` (API
  `/api/dev/gift-codes`; N days × M uses,
  optional expiry); anyone redeems on `/membership`, once per code. Not
  counted against the invite cap.

Every reward is a `membership_grant` row with UNIQUE (reason, refId), so each
is given once however often the checks run.

## GitHub Sponsors

A second way to Pro, for people who would rather pay through GitHub. Rules in
`lib/payments/sponsors.ts`, D1 side in `lib/payments/sponsors-store.ts`,
table in `db/migrations/0015_github_sponsors.sql`, endpoint
`POST /api/payments/github-sponsors-webhook`.

### Flow

1. The sponsor picks a tier on GitHub (`GITHUB_SPONSORS_URL`, linked from
   `/membership`).
2. GitHub pushes a `sponsorship` webhook. The endpoint checks
   `X-Hub-Signature-256` (HMAC-SHA256 of the raw body, Web Crypto, constant
   time): 503 while `GITHUB_SPONSORS_WEBHOOK_SECRET` is unset (or on the Mongo
   backend), 401 on a bad signature, 200 to `ping` and to any other event.
3. The sponsorship is upserted into `github_sponsorship` (keyed by its
   `node_id`) and mapped to a Lianki user through the better-auth `account`
   row with `providerId = 'github'` and `accountId` = `sponsor.id`.
4. Pro is a `membership_grant` with `reason = 'github-sponsors'`:
   - **Monthly tier ≥ $5** (`MONTHLY_MIN_CENTS`): Pro through the end of the
     current monthly period plus 7 days' grace (`GRACE_DAYS`), refId
     `<node_id>:<period start day>`, once per period. Periods are counted from
     the sponsorship's `created_at`. It never shortens Pro that already runs
     further (a pass), so overlapping time is not added twice.
   - **One-time tier**: days by price (`ONE_TIME_DAYS`: $5 → 30, $10 → 62,
     $25 → 183, $50 → 366), stacking like a pass, refId `<node_id>:once`.
5. **Renewals.** GitHub sends no event when a monthly sponsorship renews,
   only `cancelled` when it ends. So an active sponsorship counts as paid each
   period, and the period's grant is made by the next of: any `sponsorship`
   event for it (`edited`, `tier_changed`, …), or the sponsor reading
   `/api/membership/status` (which `/membership` does). The grace week covers
   the gap at a period boundary.
6. **Actions.** `created` starts it (a redelivered `created` never revives a
   cancelled one; a later `created_at` does). `tier_changed` / `edited` take
   the new price at once — under $5 stops the extensions. `pending_tier_change`
   changes nothing until GitHub's `tier_changed`. `pending_cancellation`
   records its `effective_date`; no period starting on or after it is granted.
   `cancelled` stops all further grants. Nothing already granted is taken back.

### Pending claims

A sponsor whose GitHub id has no Lianki account yet is stored with
`userId = NULL`. It is claimed — and its current period (or one-time days)
granted — when that GitHub account signs up or is linked to an existing
account (better-auth `databaseHooks.account.create.after` in `auth-impl.ts`),
and again on every membership status read, which retries a claim the hook
missed. A claimed sponsorship stays with its account; a cancelled one claimed
later grants nothing. Organisations sponsoring stay pending forever.

### Turning it on (owner)

1. Enable GitHub Sponsors on the account or organisation that should receive
   the money, and finish its Stripe Connect payout profile. If it is not
   `snolab`, change `GITHUB_SPONSORS_URL` in `lib/payments/sponsors.ts`.
2. Create the tiers: monthly from $5 (any monthly tier from $5 grants Pro);
   one-time tiers at the amounts in `ONE_TIME_DAYS`.
3. Sponsors dashboard → **Webhooks** → add
   `https://lianki.com/api/payments/github-sponsors-webhook`, content type
   **application/json**, a random secret.
4. Put the same secret on the Worker:

   ```bash
   bunx wrangler secret put GITHUB_SPONSORS_WEBHOOK_SECRET
   ```

5. GitHub sends a `ping`; the dashboard should show a 200. Until step 4 the
   endpoint answers 503, and GitHub shows the deliveries as failed (each can be
   redelivered from the dashboard later).

Sponsors who started before the webhook existed are picked up at their next
`sponsorship` event; until then, give them a gift code.
