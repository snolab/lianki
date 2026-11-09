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

Stripe has a **test / live mode** decided by the server alone — the key's
prefix and the owner's **`payments.stripe.live` feature flag**
([feature-flags.md](feature-flags.md), toggled at `/dev/flags`, no deploy, no
secret change) — in `stripeMode` (`lib/payments/stripe.ts`). It fails closed,
the same rule as KOMOJU:

| `STRIPE_SECRET_KEY` | flag `payments.stripe.live` | mode     | who can see and pay            |
| ------------------- | --------------------------- | -------- | ------------------------------ |
| `sk_test_…`         | off                         | **test** | an `admin` holder only |
| `sk_live_…`         | **on**                      | **live** | everyone                       |
| `sk_live_…`         | off                         | **off**  | nobody — no test mode on a live key |
| anything else       | anything                    | **off**  | nobody: checkout answers 503   |

"Anything else" includes a missing `STRIPE_WEBHOOK_SECRET`, a test key with
the flag on, and any other key format — restricted `rk_…` keys too (the code
uses a full secret key; accepting `rk_live_` would be a one-line, reviewed
change in `stripeKeyMode`). A flag that cannot be read (D1 error, the Mongo
backend) reads as **off**. So nothing charges real money until the owner has
set a live key _and_ turned the flag on, on purpose. The old `STRIPE_LIVE`
secret is no longer read; delete it if it is set.

In **test** mode (`lib/payments/stripe-webhook.ts`):

- the buy buttons and the "Stripe (test)" top-up show for the owner only;
  `POST /api/payments/checkout` and `/api/payments/topup` answer 503 to anyone
  else;
- the webhook credits the owner's account only — a session for anyone else
  is answered 200 and ignored (`payments.stripe.test-ignored` in
  `wrangler tail lianki`);
- what it writes is kept apart from real money
  (`db/migrations/0025_payment_test_mode.sql`, `0026_credit_test_ledger.sql`): a pass's `payment` row has
  `testMode = 1` and pays **no** inviter bonus; a top-up goes to
  `credit_test_ledger`, never to the spendable balance (see "Test credits"
  under Providers).

In both modes a signed event whose `livemode` disagrees with the key's mode
(the secrets are mixed up) credits nothing: it answers 503 and logs
`payments.stripe.mode-mismatch`, so Stripe retries for up to 3 days while the
secrets are fixed. A new Checkout Session whose `livemode` disagrees is
refused before the redirect.

### Secrets (names only — never paste values into chat or commits)

| name                     | value                                                       |
| ------------------------ | ----------------------------------------------------------- |
| `STRIPE_SECRET_KEY`      | `sk_test_…` (test) or `sk_live_…` (live) — Developers → API keys |
| `STRIPE_WEBHOOK_SECRET`  | `whsec_…` of the webhook endpoint below, **in the same mode** |
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
   `bunx wrangler secret put STRIPE_WEBHOOK_SECRET` (that `whsec_…`). Leave
   the `payments.stripe.live` flag **off**.
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
2. **Set the keys**, then **flip the flag**:

   ```bash
   bunx wrangler secret put STRIPE_SECRET_KEY      # the live secret key (sk_live_…)
   bunx wrangler secret put STRIPE_WEBHOOK_SECRET  # the live endpoint's whsec_…
   ```

   With a live key and the flag still off, Stripe is **off** for everyone,
   the owner included — nothing half-live, and no test mode on a live key.
   Then turn **`payments.stripe.live`** on at `https://lianki.com/dev/flags`;
   it reaches every request within 30 s, no deploy.
3. **One small real payment**: as the owner, top up **¥100** by card
   (Stripe now has no "(test)" label, and a second, non-owner account sees it
   too). Check: `wrangler tail lianki` shows no error; the balance is +¥100
   with a `topup` entry `stripe:<session id>` in the real ledger; the
   Dashboard shows the payment and the webhook delivery 200. Then refund it in
   the Dashboard and take it back at `/dev/credits` (撤回充值).
4. **Kill switch**: turn `payments.stripe.live` off at `/dev/flags`. Within
   30 s no new checkout or top-up can start, for anyone (see below for the
   payments already in flight).

### Live mode and the kill switch

The flag gates **starting** a payment; the webhook **settles** by the key
alone (`stripeKeyMode`, `komojuKeyMode`, `providerSettleMode`). The rule:

- **Starting** (checkout, top-up, the buy buttons) reads the flags once per
  request (`readFlags()`, `lib/flags-store.ts`) and uses that one snapshot for
  the gate and for the session it creates. Unreadable = off.
- **Settling**: a webhook whose event is genuinely live — Stripe: signed with
  the live endpoint's secret and `livemode: true` against an `sk_live_` key;
  KOMOJU: re-read from the API with the `sk_live_` key — is credited **whatever
  the flag says now**. Such a payment can only have been started by this
  server while the flag was on: only the checkout and top-up routes create
  sessions carrying our `userId` metadata, and only in live mode. Rejecting it
  after a flip would take a customer's money and give nothing back.
- Why the webhook does not look the flip up in the flag log instead: a
  session can start up to 30 s after a flip in an isolate whose cache had not
  caught up, and a konbini or bank-transfer payment started before the flip is
  paid days later. Both are real money this server asked for; a time check
  would refuse them.
- So the kill switch **stops new payments** within 30 s and never drops paid
  ones. A payment page already issued stays payable until it expires: a Stripe
  Checkout link is created with `expires_at` 31 minutes out
  (`CHECKOUT_EXPIRES_S`, Stripe's 30-minute minimum plus a minute for clock
  skew) instead of Stripe's 24 h default; a KOMOJU session keeps KOMOJU's own
  expiry, and a konbini slip its payment deadline. To stop crediting as well (a leaked key, say), rotate or delete the
  keys — the webhook then answers 503 and the provider retries (Stripe for 3
  days, KOMOJU for 25), so nothing is lost while it is fixed.
- A test event against a live key (or the reverse) is still refused, flag or
  not (`payments.stripe.mode-mismatch`).
- `/dev/flags` cannot turn a live flag **on** until the Worker has an
  `sk_live_` key and its webhook secret (`stripeKeyMode` / `komojuKeyMode` =
  `"live"`; the API answers 400 otherwise). Off always works.
  [feature-flags.md](feature-flags.md), "Prerequisites". The page also notes
  that real charging is confirmed by the owner typing in Slack first.

Unit tests: "a flag flip while a checkout is in flight" in
`unit/stripe-mode.test.ts` and `unit/komoju.test.ts`.

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

**Shown in credits, never a currency** (owner, 2026-11-03): one credit is what
¥1 of top-up buys, so the ledger's amount _is_ the number of credits. The
balance, pass prices bought from it, the history and gift-code credits read
"1,200 credits" (pluralized per locale: `credit-units.content.ts`,
`lib/payments/credit-units.ts`); yen appears only where money is charged — a
top-up reads "¥600 → 600 credits". `/dev/credits` and `/dev/gift-codes` say 积分.

### Ledger

- `credit_ledger` is append-only: one row per change, amount in JPY signed
  (+ top-up, gift, sponsor, refund to the wallet; − a pass, a reversed
  top-up, − an AI reply's reservation), reason
  `topup | pass | refund | gift | sponsor | adjust | ai`, and
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
  or `topup:<top-up refId>`; gift `<code>:<userId>`; admin `admin:<uuid>`;
  AI reply `ai:<userId>:<line id>` (the `ai` reservation and its `refund`
  share it — docs/partner-ai.md, "Credits"; tables `credit_ai_charge`,
  `credit_ai_carry` in `0041_ai_credits.sql`).
- USD-priced costs (AI calls) become credits at `CREDITS_PER_USD`
  (`lib/payments/credits.ts`), the one place to change when the credit unit
  is redesigned.

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
**test mode** is listed for an `admin` holder only, labelled
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
| `stripe`          | checkout | card, Alipay, WeChat Pay                    | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (+ flag `payments.stripe.live` for live) | implemented — test mode until live ([above](#turning-it-on)) |
| `komoju`          | checkout | card, konbini, PayPay, Alipay, WeChat Pay   | `KOMOJU_SECRET_KEY`, `KOMOJU_WEBHOOK_SECRET` (+ flag `payments.komoju.live` for live) | implemented — test mode until live (below) |
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

- **Mode** comes from the server only (`komojuMode`), and fails closed:
  **test** needs an `sk_test_…` key and the **`payments.komoju.live`** flag
  off; **live** needs an `sk_live_…` key _and_ the flag on (`/dev/flags`);
  anything else — a missing secret, a live key with the flag off, a test key
  with it on, a flag that cannot be read, or a key in any other format (KOMOJU
  decides the mode by the key alone and has no API field that says which) — is
  **off**: no new session. So nothing charges real money until the owner sets
  a live key and turns the flag on, on purpose. The webhook settles by the key
  alone, so a payment started while live was on still credits after the flag
  is turned off ("Live mode and the kill switch", above). The old
  `KOMOJU_LIVE` secret is no longer read; delete it if it is set.
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
   ```

   Secrets apply at once, no deploy needed; with the flag still off KOMOJU is
   **off** for everyone. Then turn **`payments.komoju.live`** on at
   `https://lianki.com/dev/flags` (within 30 s, no deploy). The live key must start with
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
4. **Kill switch**: turn `payments.komoju.live` off at `/dev/flags` — no new
   KOMOJU payment starts within 30 s; payments already started (a konbini
   slip printed before the flip) still credit when paid.

#### Adding a provider

1. Write `lib/payments/providers/<id>.ts` exporting a `PaymentProvider`
   (`types.ts`): `createTopup(amount, user, urls, mode)` returns
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
7. If it has a test/live mode, give it a `payments.<id>.live` flag in
   `lib/flags.ts`, a `mode(env, flags)` that needs the live key _and_ the flag
   (live key + flag off = off), and a `keyMode(env)` for its webhook that reads
   the key alone ("Live mode and the kill switch").

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

### Once per person: the canonical email

"Once" means once per **person**, not per account (owner, 2026-11-05):
`lib/canonical-email.ts` maps an address to its canonical form — for
gmail.com / googlemail.com dots removed, `+tag` dropped, googlemail → gmail;
`+tag` also dropped for the providers in `PLUS_ALIAS_DOMAINS`; any other
domain only lowercased. Stored as `user.email_canonical` (indexed,
`db/migrations/0043_email_canonical.sql`, backfilled there), set by the
better-auth `user.create` / `user.update` hooks and filled lazily by the checks
(`lib/canonical-email-d1.ts`). It is used **only** for these checks; sign-in and
the account keep the address as given, and no accounts are merged.

- **Trial**: an account whose canonical email belongs to another account that
  already had a trial or Pro gets no trial — `trialEndsAt` is set to now, so it
  is free and stays so. Accounts that already have a trial are never touched.
- **Invites**: an alias of the inviter is `self`; an invitee with any other
  account of the same canonical email is `not new`.
- **Gift codes**: redeemed by one account, spent for all its aliases.
- **Per-person limits**: `accountKey` (sign-in lockout, code sends) and
  `personKey` (`lib/rateLimit.ts`, the AI/TTS limits) key on it.

At the migration (2026-11-05) no two existing accounts shared a canonical email.

### Invite by email

Owner request 2026-11-09. A Pro user (or an admin) types one friend's address in
the invite card on `/membership`; Lianki mails that friend the inviter's existing
`/i/CODE` link. Same code, same rewards as a shared link — no new code type.

| piece | where |
| --- | --- |
| limits (one object) | `lib/referrals/email-invite-config.ts` (`EMAIL_INVITE`, `INVITE_MAIL_SENDER`) |
| send, status, opt-out, tokens | `lib/referrals/email-invite.ts`; routes `app/api/invite/email/route.ts`, `app/api/invite/email/opt-out/route.ts` |
| the template (one module) | `lib/referrals/invite-mail.ts` + strings `lib/referrals/invite-mail.content.ts` (16 locales, context lines) |
| preview, sends nothing | `previewInviteMail()` / `renderFor()`; admin-only `GET /api/dev/invite-mail-preview?format=html\|text\|json&locale=` renders his own mail |
| UI | `app/(app)/membership/EmailInviteBox.tsx`; opt-out page `/membership/invite-opt-out` |
| tables | `db/migrations/0061_invite_email.sql`: `invite_email_log`, `invite_email_recipient`, `invite_email_suppression` |
| tests | `unit/email-invite.test.ts`; QA `scripts/qa/qa-email-invite.mjs` (suite `email-invite`) |

- **Who**: `isAdmin` always; Pro (`proEndsAt` in the future, not trial) once the
  flag `membership.email-invite` is on. Off: admins only.
- **Limits** (first values, the owner may change them): 5 requests per inviter in
  24 h, counted with the log row in one conditional INSERT; one invite mail per
  address in 30 days from anyone, claimed with one conditional upsert on the
  canonical address's hash; an inviter whose mails were reported 2 times in a
  year sends nothing more. Failed sends are not counted and give the address's
  window back.
- **One address per request**, validated (`oneAddress`): lists, `Name <addr>`
  forms and junk are 400.
- **Neutral answer**: an address with an account (any form, the inviter's own
  included), a suppressed one, one mailed recently, or a blocked inviter — no
  mail, and the same `{status:"sent"}` as a real send. Every one of these counts
  against the daily limit, so the limit cannot be used to probe.
- **No address stored**: `recipientHash` = SHA-256 of the canonical address;
  `recipientMasked` (`a***@example.com`) only for the inviter's own history.
  Keyed by user id, so nothing moves on an email change (not in
  `EMAIL_KEYED_TABLES`). No log line holds an address.
- **Language**: the inviter's account language (`ui.locale` in `user_prefs`),
  else `user.signupLocale`, else English (`lib/signup-locale.ts`). zh / zh-CN /
  zh-Hans read the Simplified template; there is no Traditional one, so zh-Hant
  reads it too. The send API takes an optional `locale` for a later override (no
  UI). The opt-out page opens in the same language (`?lang=`).
- **The mail**: who invited (display name in the subject, the first line and
  the footer; a name that reads like an address or a link becomes "A friend"),
  the link, and a compliance footer: why you got it (a friend, one time, no
  list), "This email was sent to {address} because {name} invited you." just
  above the Unsubscribe link (the address exactly as sent, HTML-escaped and
  `<bdi>`-isolated; rendered into that one message only — never stored or
  logged; the preview shows `friend@example.com`), Unsubscribe and Report abuse
  links, the sender (Lianki, the site) and
  the contact page. `INVITE_MAIL_SENDER.postalAddress` is an empty slot: CAN-SPAM
  wants a postal address and the repo has none — the line appears once it is set.
- **Headers**: `List-Unsubscribe: <https://…/api/invite/email/opt-out?t=…>` and
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058). No `mailto:`:
  there is no inbound mailbox.
- **Opt-out**: the one-click POST (form body `List-Unsubscribe=One-Click`, no
  sign-in) and the page's buttons (same-origin JSON) both write
  `invite_email_suppression`, idempotently; Report also stamps the log row. The
  token is `<logId>.<HMAC>` with a key derived from `AUTH_SECRET` by HKDF (no new
  secret), so nobody can opt out an address they did not receive. A GET on the
  one-click URL only redirects to the page. Per-IP limit 30 / 15 min.
- **Bounces and complaints** are not wired yet: Resend's webhooks are signed
  (Svix) and need a new secret (`RESEND_WEBHOOK_SECRET`) and a webhook set up in
  Resend. The suppression table already takes `bounce` / `complaint`.
- **Local servers never mail**: on a localhost origin the send is a stub
  (`invite-email.stub-send`, no address), whatever `.dev.vars` holds.

### `user.signupLocale`

The browser language at an account's first sign-up: the best supported tag from
`Accept-Language`, normalised (`en`, `ja`, `zh-Hans`, `zh-Hant`…), and **nothing
else from the header**. Written once by the better-auth `user.create` hook
(`lib/signup-locale-d1.ts`), never overwritten. Accounts made before
`db/migrations/0062_user_signup_locale.sql` stay NULL — no backfill, no guess.
Used only as the invite mail's fallback language.

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
