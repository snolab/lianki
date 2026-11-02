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
   Crypto (`lib/payments/stripe.ts`; handling in
   `lib/payments/stripe-webhook.ts`), then `lib/payments/fulfil.ts` writes a
   `payment` row (keyed by the session id, `db/migrations/0013_payments.sql`)
   and the new `proEndsAt` in one D1 batch. A redelivered event is a no-op.

No Stripe SDK: a fetch call and an HMAC are all it needs, and nothing
Node-only reaches the Worker. D1 only — on the Mongo backend the routes 503.

## Turning it on

Stripe has a **test / live mode** decided by the Worker's settings only
(`stripeMode` in `lib/payments/stripe.ts`), and it fails closed — the same
rule as KOMOJU:

| `STRIPE_SECRET_KEY` | `STRIPE_LIVE` | mode     | who can see and pay                     |
| ------------------- | ------------- | -------- | --------------------------------------- |
| `sk_test_…`         | unset         | **test** | the owner (`OWNER_EMAILS`) only         |
| `sk_live_…`         | `1`           | **live** | everyone                                |
| anything else       | anything      | **off**  | nobody: checkout and webhook answer 503 |

"Anything else" includes a missing `STRIPE_WEBHOOK_SECRET`, a test key with
`STRIPE_LIVE=1`, a live key without it, `STRIPE_LIVE` set to anything but
`1`, and any other key format — restricted `rk_…` keys too (the code uses a
full secret key; accepting `rk_live_` would be a one-line, reviewed change in
`stripeMode`). So nothing charges real money until the owner sets both a live
key and the flag on purpose.

In **test** mode (`lib/payments/stripe-webhook.ts`):

- the buy buttons and the "Stripe (test)" top-up show for the owner only;
  `POST /api/payments/checkout` and `/api/payments/topup` answer 503 to anyone
  else;
- the webhook credits the owner's account only — a session for anyone else
  is answered 200 and ignored (`payments.stripe.test-ignored` in
  `wrangler tail lianki`);
- what it writes is kept apart from real money
  (`db/migrations/0025_payment_test_mode.sql`): a pass's `payment` row has
  `testMode = 1` and pays **no** inviter bonus; a top-up goes to
  `credit_test_ledger`, never to the spendable balance (see "Test credits"
  under Providers).

In both modes a signed event whose `livemode` disagrees with the mode (the
secrets are mixed up) credits nothing: it answers 503 and logs
`payments.stripe.mode-mismatch`, so Stripe retries for up to 3 days while the
secrets are fixed. A new Checkout Session whose `livemode` disagrees is
refused before the redirect.

### Secrets (names only — never paste values into chat or commits)

| name                     | value                                                       |
| ------------------------ | ----------------------------------------------------------- |
| `STRIPE_SECRET_KEY`      | `sk_test_…` (test) or `sk_live_…` (live) — Developers → API keys |
| `STRIPE_WEBHOOK_SECRET`  | `whsec_…` of the webhook endpoint below, **in the same mode** |
| `STRIPE_LIVE`            | `1` for live; unset for test                                |
| `STRIPE_PAYMENT_METHODS` | optional, comma-separated (default `card,alipay,wechat_pay`) |

Each is a Worker secret (`bunx wrangler secret put <name>`); secrets apply at
once, no deploy needed.

In the Stripe Dashboard (once per mode — test and live are separate):

- **Settings → Payment methods**: enable Alipay and WeChat Pay.
  `STRIPE_PAYMENT_METHODS` (comma-separated) overrides the offered list if one
  is not enabled yet; Checkout errors on a method the account lacks.
- **Developers → Webhooks**: endpoint
  `https://lianki.com/api/payments/stripe-webhook`, events
  `checkout.session.completed` and `checkout.session.async_payment_succeeded`.

### Testing now (test keys)

1. Dashboard in **test mode**: add the webhook endpoint above; copy its
   signing secret.
2. `bunx wrangler secret put STRIPE_SECRET_KEY` (the `sk_test_…` key) and
   `bunx wrangler secret put STRIPE_WEBHOOK_SECRET` (that `whsec_…`). No
   `STRIPE_LIVE`.
3. As the owner, buy a pass on `/membership` with card `4242 4242 4242 4242`
   (Checkout shows "Test mode"): Pro is extended and the `payment` row has
   `testMode = 1`. Top up ¥100 with "Stripe (test)": `/dev/credits` shows it
   under 测试余额, and the real balance is unchanged. A non-owner account sees
   no buy buttons and no Stripe top-up.

### Going live

Before live keys: a 特定商取引法 page, terms and privacy policy (Stripe Japan's
review asks for them), and the owner's 資格外活動許可. Then:

1. Dashboard in **live mode** → Developers → Webhooks → add
   `https://lianki.com/api/payments/stripe-webhook` with the two events above;
   copy its (live) signing secret. Enable Alipay and WeChat Pay in live mode.
2. Put the live secrets on the Worker, the flag last:

   ```bash
   bunx wrangler secret put STRIPE_SECRET_KEY      # the live secret key (sk_live_…)
   bunx wrangler secret put STRIPE_WEBHOOK_SECRET  # the live endpoint's whsec_…
   bunx wrangler secret put STRIPE_LIVE            # 1
   ```

   Between the first put and the last, Stripe is **off** (a live key without
   the flag is refused) — nothing half-live.
3. **One small real payment**: as the owner, top up **¥100** by card
   (Stripe now has no "(test)" label, and a second, non-owner account sees it
   too). Check: `wrangler tail lianki` shows no error; the balance is +¥100
   with a `topup` entry `stripe:<session id>` in the real ledger; the
   Dashboard shows the payment and the webhook delivery 200. Then refund it in
   the Dashboard and take it back at `/dev/credits` (撤回充值).
4. If anything is off: `bunx wrangler secret delete STRIPE_LIVE` turns Stripe
   off at once.

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
tables in `db/migrations/0024_credits.sql`, UI in
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
listed on `/membership` only when it is **implemented, every one of its
`envKeys` is set** on the Worker, and its mode is not off. A provider in
**test mode** is listed for the owner (`OWNER_EMAILS`) only, labelled
"(test)", and its webhook credits the owner only — and only to the test
ledger — so a test card can never become anyone's real credits.

**Test credits** (`creditTestTopup` / `refundTestTopup` in
`credits-store.ts`): a test-mode top-up is written to `credit_test_ledger`
(once per `<provider>:<paymentId>`, blocked by a refund mark like a real one),
never to `credit_ledger` / `credit_balance`. So test credits cannot buy a pass
— and so cannot trigger the inviter's purchase bonus, or any real value for
anyone — and they never turn into real balance, not even after the provider
is switched to live. They show at `/dev/credits` (测试余额) and under `test`
in `GET /api/payments/credits`. A test-mode refund takes them back from the
test ledger only. To try buying a pass with the balance, give the owner
credits at `/dev/credits` (adjust) instead.

| id                | kind     | methods                                     | env (secrets)                                  | state       |
| ----------------- | -------- | ------------------------------------------- | ---------------------------------------------- | ----------- |
| `stripe`          | checkout | card, Alipay, WeChat Pay                    | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (+ `STRIPE_LIVE=1` for live) | implemented — test mode until live ([above](#turning-it-on)) |
| `komoju`          | checkout | card, konbini, PayPay, Alipay, WeChat Pay   | `KOMOJU_SECRET_KEY`, `KOMOJU_WEBHOOK_SECRET` (+ `KOMOJU_LIVE=1` for live) | implemented — test mode until live (below) |
| `payjp`           | checkout | card (3-D Secure, checkout-policy.ts)       | `PAYJP_SECRET_KEY`, `PAYJP_WEBHOOK_TOKEN`      | slot        |
| `paddle`          | checkout | card, PayPal, Apple Pay                     | `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`      | slot        |
| `usdt`            | checkout | USDT TRC-20 / ERC-20 (QR)                   | `USDT_GATEWAY_API_KEY`, `USDT_GATEWAY_WEBHOOK_SECRET` | slot |
| `afdian`          | grant    | 爱发电 (Alipay, WeChat Pay)                  | `AFDIAN_USER_ID`, `AFDIAN_API_TOKEN`           | slot        |
| `patreon`         | grant    | Patreon                                     | `PATREON_WEBHOOK_SECRET`                       | slot        |
| `github-sponsors` | grant    | GitHub Sponsors (as credits, not Pro days)  | `GITHUB_SPONSORS_CREDITS`                      | slot        |

`checkout` providers start a payment of an amount the user picks; `grant`
providers have no button — money arrives on another platform and its webhook
credits the wallet as `sponsor`.

#### KOMOJU

`lib/payments/providers/komoju.ts`, webhook handling in
`lib/payments/webhook.ts`, tests in `unit/komoju.test.ts`.

- **Mode** comes from the Worker's settings only (`komojuMode`), and fails
  closed: **test** needs an `sk_test_…` key and no `KOMOJU_LIVE`; **live**
  needs an `sk_live_…` key _and_ `KOMOJU_LIVE=1`; anything else — a missing
  secret, a key that disagrees with the flag, or a key in any other format
  (KOMOJU decides the mode by the key alone and has no API field that says
  which) — is **off**: no session, no credit. So nothing charges real money
  until the owner sets both a live key and the flag on purpose.
- **Top-up**: `POST /api/payments/topup` (rate limit + Turnstile, amount
  validated on the server, ¥100–¥10,000) creates a KOMOJU session —
  `amount`, `currency: JPY`, `return_url` `/membership?topup=1`, and
  `metadata {userId, kind: "topup", amount}` — and redirects to its
  `session_url`.
- **Webhook** `POST /api/payments/webhook/komoju`: `X-Komoju-Signature` must
  be the HMAC-SHA256 hex of the raw body with `KOMOJU_WEBHOOK_SECRET`
  (constant-time compare), else 400. The body is only a hint: on
  `payment.captured` the payment is **re-read from the KOMOJU API** (and the
  session this server created), and the credit is the API's `amount` (not
  `total`, which adds the konbini fee), JPY only, status `captured`, for the
  session's `userId`, and only if it equals the session's amount. Konbini and
  bank transfer settle days later — they credit on their own `captured`.
  Credited once per `komoju:<payment id>`; a redelivery is a no-op. An API
  failure is a 500, so KOMOJU retries (up to 25 times over 25 days).
- **Refunds**: a full refund (`payment.refunded`, re-read: status `refunded`)
  takes the top-up back once, and always leaves a `credit_refund_mark` for the
  payment in the same batch. A top-up is credited only `WHERE NOT EXISTS` that
  mark, so a capture webhook that read "captured" before the refund and
  commits after it credits nothing (unit test "held mid-read"). If the credits were already spent, nothing is
  overdrawn: it logs `credits.refund.unsettled` (wrangler tail) — settle at
  `/dev/credits` (refund the pass first, then 撤回充值). Partial refunds
  (`payment.refund.created`) are not automated; settle by hand.

**Testing now (test keys):** set the test-mode secrets below with the
`sk_test_…` key, sign in as the owner, top up ¥100 on `/membership` with a
KOMOJU test card; `/dev/credits` shows it under 测试余额 (the real balance is
unchanged — test credits are never spendable). Other accounts see no KOMOJU
button.

**Going live** (after KOMOJU approves the Live application):

1. KOMOJU dashboard (live mode) → **Webhooks** → add
   `https://lianki.com/api/payments/webhook/komoju`, events
   `payment.captured` and `payment.refunded`, with a new random secret token.
2. Put the live secrets on the Worker (names only — never paste values into
   chat or commits):

   ```bash
   bunx wrangler secret put KOMOJU_SECRET_KEY      # the live secret key (sk_live_…)
   bunx wrangler secret put KOMOJU_WEBHOOK_SECRET  # the live webhook's secret token
   bunx wrangler secret put KOMOJU_LIVE            # 1
   ```

   Secrets apply at once, no deploy needed. The live key must start with
   `sk_live_`; if KOMOJU's live key has another format, KOMOJU stays **off**
   (no button anywhere) — accepting that format is then a one-line code change
   in `komojuMode`, reviewed like any payment change.
3. **One small real payment**: as the owner, top up **¥100** by card on
   `/membership` (KOMOJU now has no "(test)" label, and a second, non-owner
   account sees it too). Check: `wrangler tail lianki` shows no error; the
   real balance is +¥100 with a `topup` entry `komoju:<payment id>`; the
   KOMOJU dashboard shows the payment captured and the
   webhook delivery 200. Then refund it in the KOMOJU dashboard and check the
   wallet goes back to its old balance (a `refund` entry `topup:komoju:…`).
4. If anything is off: `bunx wrangler secret delete KOMOJU_LIVE` turns
   KOMOJU off at once (an `sk_live_` key without the flag is refused).

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
