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

| `STRIPE_SECRET_KEY` | flag `payments.stripe.live` | mode     | who can see and pay                 |
| ------------------- | --------------------------- | -------- | ----------------------------------- |
| `sk_test_…`         | off                         | **test** | an `admin` holder only              |
| `sk_live_…`         | **on**                      | **live** | everyone                            |
| `sk_live_…`         | off                         | **off**  | nobody — no test mode on a live key |
| anything else       | anything                    | **off**  | nobody: checkout answers 503        |

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

| name                     | value                                                            |
| ------------------------ | ---------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`      | `sk_test_…` (test) or `sk_live_…` (live) — Developers → API keys |
| `STRIPE_WEBHOOK_SECRET`  | `whsec_…` of the webhook endpoint below, **in the same mode**    |
| `STRIPE_PAYMENT_METHODS` | optional, comma-separated (default `card,alipay,wechat_pay`)     |

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

| endpoint                                    | does                                                                                                                                                             |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/payments/credits`                 | balance, the newest 50 entries, top-up limits and the **enabled** providers                                                                                      |
| `POST /api/payments/topup`                  | `{amount, provider?, turnstileToken}`, ¥100–¥10,000 whole yen → `{kind:"redirect",url}` or `{kind:"qr",qr}`. Same rate limit + Turnstile as pass checkout        |
| `POST /api/payments/buy-pass`               | `{passId, key}` → 200 `{balance, proEndsAt}`, or **402** `{balance, price, missing}` — the page offers a top-up of exactly `missing` (at least the ¥100 minimum) |
| `POST /api/payments/webhook/<provider>`     | the provider's webhook; it verifies its own signature, then credits the ledger keyed by provider + paymentId                                                     |
| `POST /api/payments/stripe-webhook`         | Stripe's single endpoint: passes as before, and sessions with `metadata.kind = "topup"` credit the wallet                                                        |
| `GET/POST /api/dev/credits`, `/dev/credits` | owner only (404 otherwise): look a wallet up; add/take credits (`sponsor`/`adjust`/`gift`); refund a credit-bought pass to the wallet; reverse a refunded top-up |

Quick amounts are ¥600, ¥1,200, ¥3,000 and ¥5,000, so they line up with the
passes. A Stripe top-up credits `amount_total` — what was actually paid, JPY
only — not the amount the metadata asked for. Buying a pass with credits also
triggers the inviter's first-pass bonus.

Gift codes can carry credits (`gift_code.credits`) as well as, or instead of,
Pro days; both land in one batch with the `membership_grant` marker, once per
person per code.

### Login-streak bonus

Owner decision 2026-11-14: credits for **consecutive days of real learning**,
replacing the account-age bonus (below, "Retired"). A day counts when the
server records a qualifying learning action — a card reviewed on /words
(on screen at least human reaction time) or a reading graded in /read — that
is, the `study_day` write (`lib/study-days.ts`); opening the app counts for
nothing. One grant per calendar day in the account's **home time zone** (the
zone its first study day was cut in, as for study days).

| piece                                            | where                                                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| rules (pure): the cycle, the miss rule, refIds   | `lib/payments/login-streak.ts`                                                                     |
| state + grant over D1, the wallet's view         | `lib/payments/login-streak-store.ts`; table `login_streak` (migration 0076)                        |
| hook: the day's first qualifying action          | `recordStudySafe` in `lib/study-days.ts` (both the /words review and /read grade routes call it)   |
| shown                                            | the wallet card on /membership: one quiet line under the balance, and the history row label         |
| strings                                          | `wallet-card.content.ts` `streakToday` / `streakAhead` / `streakDay` (16 locales, context lines)    |
| flag                                             | `credits.login-streak`, **default ON** for everyone (it grants, never charges)                      |
| tests                                            | `unit/login-streak.test.ts`, `unit/study-days.test.ts` ("recording from a route")                   |

- **Config** (`lib/config.ts`, `/dev/config`, group `credits`, both `money`):
  - `credits.loginStreak.usdByDay` (text, default
    `0.02,0.02,0.05,0.05,0.06,0.10,0.20`): USD for cycle day 1, 2, … — its
    length is the cycle (7 by default, $0.50 a cycle; day 8 pays as day 1
    again). Each becomes credits at `CREDITS_PER_USD`, rounded (3, 3, 8, 8,
    9, 15, 30 today). A 0 pays nothing for that day but the day still counts.
  - `credits.loginStreak.missCostDays` (default **2**): each missed calendar
    day costs this many streak days — **never a full reset**. 7 days, one
    missed, learn again: 7 − 2 + 1 = **6**, paid as cycle day 6. 0 = misses
    are free; a large value (1000) ≈ start over after any miss. Chosen as the
    conservative middle: a one-day slip costs two steps, a week away costs the
    streak.
- **The rule** (`nextStreak`): the streak after today = max(0, previous −
  missed × missCost) + 1; its cycle step = ((streak − 1) mod cycle) + 1. The
  same day, an earlier day, or an unreadable day does nothing.
- **Ledger**: reason `gift` (no new reason, so no CHECK migration), refId
  `streak:<userId>:<day>`, note `login streak day <step> (<streak>)`. UNIQUE
  (reason, refId) makes a day once per account. The `login_streak` row moves
  only forward (`WHERE day < the new day`) in the **same D1 batch** as the
  ledger row (`INSERT OR IGNORE … WHERE EXISTS the user`) and the balance
  move (`WHERE EXISTS` that ledger row) — so a retry, a second review that
  day, or two concurrent first reviews pay once and agree on the streak.
- **Event-driven** (no cron, no timer): the first qualifying action of a day
  (`recordStudy` reports whether it opened the day) runs the grant once; later
  reviews of the day touch nothing. The wallet read is read only — it never
  counts a day. A failing grant never fails the review; it is logged as
  `login-streak: grant failed`.
- **Shown**: the wallet card's line reads "Day N of your streak · +X" once
  today counted, or "Learn today for streak day N · +X" (what today would pay)
  before; no line while the flag is off or the day would pay 0. A grant in the
  history reads "Streak bonus · day N" (N = the streak length that day).
- **Admins are metered the same**: there is no admin or dev branch anywhere in
  the rule or the grant.
- Every account counts, verified email or not; if farming shows up, setting
  every amount to 0 stops new grants at once (the flag off stops the counting
  and hides the line; credits already granted stay).

### Sign-up bonus

Owner decision 2026-11-15 (12:4x JST): every **new account** gets **US$1**
of credits once — but only the **first 10 new accounts of each UTC day**
(the day turns at 09:00 JST). Shipped on; no switch to flip. Added 13:0x JST:
accounts that **already existed** when it launched get the same US$1 once,
outside the cap.

| piece                                      | where                                                                                              |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| rules (pure): refId, UTC day, credits      | `lib/payments/signup-bonus.ts`                                                                     |
| claim + grant over D1, the hook entry      | `lib/payments/signup-bonus-store.ts`; tables `signup_bonus_day`, `signup_bonus_launch` (migration 0079) |
| hooks                                      | better-auth `user.create.after` (new) and `session.create.after` (backfill) in `auth-impl.ts`; the wallet read `GET /api/payments/credits` (backfill) |
| shown                                      | the wallet history row label only: 「注册礼」 (`wallet-card.content.ts` `signupBonus`, 16 locales)     |
| flag                                       | `credits.signup-bonus`, **default ON** for everyone — the off switch for both paths                |
| config                                     | `credits.signupBonusUsd` (default **1**), `credits.signupBonusDaily` (default **10**), group `credits`, both `money` |
| audit                                      | one `security_audit` row per grant, kind `credits.signup-bonus` (path, UTC day, slot, credits)     |
| tests                                      | `unit/signup-bonus.test.ts`                                                                        |

- **Ledger**: reason `gift` (no new reason, so no CHECK migration), refId
  `signup:<userId>` for both paths — UNIQUE (reason, refId) makes it once per
  account, whichever path runs first, however often it is retried. Note
  `signup bonus <UTC day> #<slot>` (new) or `signup bonus (existing account)`
  (backfill).
- **The daily cap, atomically**: one D1 batch (one transaction) per claim —
  open the day's `signup_bonus_day` row at 0; `INSERT OR IGNORE` the ledger
  row only WHERE the user exists AND that day's `granted` < the cap (its note
  takes slot `granted + 1`); add 1 to `granted` and move the balance only
  WHERE EXISTS that very ledger row. D1 runs batches one at a time, so no two
  accounts can both be number 10, and a repeat of the same account takes no
  slot. Account 11 gets nothing and sees nothing — no error, no line.
- **The backfill, lazily**: no batch job over production rows. An account
  whose `user.createdAt` is before `signup_bonus_launch.at` (the moment
  migration 0079 ran in production) gets the bonus on its next sign-in or its
  next wallet read, outside the cap. After one cheap read (it already has the
  row) every later sign-in stops. Accounts created after launch never qualify
  here, so missing the cap stays missed. Accounts created in the short gap
  between the migration and the new Worker going live get neither.
- **Never blocks**: the hook entry (`runSignupBonus`) never throws; a failure
  is logged as `signup-bonus: grant failed` and the sign-up, sign-in or wallet
  read goes on.
- **Admins are metered the same**: no admin or dev branch anywhere.
- **Abuse**: one bonus per account; the cap bounds new-account farming to 10
  × US$1 a day site-wide. Setting `credits.signupBonusUsd` to 0 (or the
  daily cap to 0 for new accounts) stops new grants at once; the flag off
  stops both paths. Credits already granted stay.

#### Retired: the account-age bonus (2026-11-14)

The earlier bonus ($1 at 1 day, $2 more at 7 days per account, 2026-11-14
morning) was replaced by the streak the same day. Its code, the
`/dev/credits` backfill panel, `POST /api/dev/credits/age-bonus` and the
config keys `credits.ageBonus.day1Usd / day7Usd / day1Hours / day7Hours` are
gone; a `config_values` row under those keys is ignored (unknown keys read
as nothing). **The data stays**: its ledger rows (`gift`,
`agebonus:d1|d7:<userId>`) keep their balance and their wallet label
("Welcome bonus · 1 day / 7 days", `ageBonusDay1` / `ageBonusDay7`). No
migration: there was no table and no flag of its own.

### Credits usage (`/membership/credits`)

Owner, 2026-11-09: a prominent place to audit credits. One tap from the
account menu ("Credits usage") and from the wallet card's history heading.
Rules in `lib/payments/credit-usage.ts`, the handler in
`credit-usage-handler.ts`, the page in `app/(app)/membership/credits/`,
`GET /api/payments/credits/usage` (`?tz&group&from&to&offset&limit`, or
`&format=csv`).

- **Every ledger line of the signed-in user, only theirs** (the user id is the
  session's, never the query's): time in the viewer's zone, feature, amount,
  the balance after it.
- **Actual spend only** (owner, 2026-11-09): a paid action is one line of its
  net charge — what it really cost. Its hold and the release `settleAi`
  writes (an `ai:` refund with the same refId) never show, on the page or in
  the CSV; an action that kept nothing (a failure, a refusal, a reply under a
  credit) is not shown at all. A hold not settled yet reads "Still running".
  The ledger keeps every row; this is display only (admin views see all).
- **A refund after the fact is its own line**, linked to the line it gives
  back: a pass refunded to the wallet (`pass:<refId>`), a reversed top-up
  (`topup:<refId>`). Every `ai:` refund is a settle today — there is no
  later-refund path for an AI charge; one would need a refId of its own.
- **Feature**: an `ai` row's `note` is the metered call's feature id
  (`FEATURES` maps each to a group and the page it was used on); no note = a
  Learning Partner reply. Other reasons are their own feature. A line links to
  that page; it never carries what the user wrote.
- **Balance after**: the running sum of the ledger in written order, started so
  that it ends on the cached `credit_balance` (a wallet over `MAX_ROWS` =
  20,000 lines shows its newest).
- **Filters** by feature group and local day range (inclusive); **this
  month's** totals per group in the viewer's zone; **CSV** of the filtered
  lines, oldest first (one row per action, its net amount; `status` pending;
  `refund_of` the time of the line a refund gives back), times in UTC and
  local, formula-looking cells defused.
- Tests: `unit/credit-usage.test.ts`; QA `scripts/qa/qa-credits-usage.mjs`
  (suite `credits-usage`).

### Refunds

- **A pass bought with credits**: `/dev/credits` → "退回余额" returns the
  price to the wallet and takes the pass's days off `proEndsAt` (never before
  now), once.
- **A top-up refunded at the provider** (Stripe Dashboard): `/dev/credits` →
  "撤回充值" takes the credits back. Refused if they were already spent — the
  balance never goes negative; refund the pass first, or settle by hand.
- No refund of unused credits to the user's card yet — see the open question
  below.

### What costs credits

Owner, 2026-11-09: "every paid service must run on the USER's credits". Every
server path a signed-in user can reach that calls a paid provider is paid from
that user's wallet — or by their own key (BYOK, [byok.md](byok.md): the call
goes from their browser to their provider and never reaches ours), or it is
free for everyone because nothing is billed (cached answers, recorded clips).
There is **no free allowance**: a balance of 0 gets the refusal below — except
the features the owner keeps free (2026-11-09, card o3): **word read-aloud**
(`words.tts`, legacy `tts`) and **the microphone** (`speech.stt`). They take no
hold and charge nothing; each call logs its cost to us (`freeCall` in
`lib/payments/paid-calls.ts`, `credits.free` with `why: "free-feature"`), so
the choice can be revisited with numbers.

**Pre-authorisation + refund** (`lib/payments/metered.ts`, on top of
`lib/payments/ai-credits.ts`):

1. **Sweep** — holds still pending `HOLD_STALE_MS` (10 min) after they were
   taken belong to a call that crashed: released in full. Run on the next paid
   request, never by a timer.
2. **Hold** — the most the call can cost is debited in whole credits before the
   provider is asked: an `ai` ledger row (refId `ai:<feature>:<userId>:<uuid>`,
   `note` = the feature id) and the balance change in **one D1 batch**. The
   balance's `CHECK (balance >= 0)` (`0024_credits.sql`) trips on an overdraft
   and rolls the batch back, so a negative balance cannot be written by any
   code path, and N concurrent holds on a small balance pass only as far as it
   covers (unit test "N parallel holds"). Not enough → **refused, the provider
   never called**: HTTP **402** `{error: "no-credits", balance, need, topUp:
"/membership"}` with the header `x-lianki-credits: needed`.
3. **Call** — with the feature's fixed limits (max output tokens, text length,
   audio size: the same for everyone, never shrunk to fit a low balance).
4. **Settle** — the real cost (provider-reported tokens; for speech and
   transcription, estimated from the text length or audio size) is kept;
   fractions of a credit carry in `credit_ai_carry`; the rest comes back as a
   `refund` row with the same refId. The provider failed → full refund. Once
   only (`pending → settled`).

**The hold is a hard cap.** It is computed from the very limits the call is
made with — 2 input tokens per prompt character (a ceiling: Latin text is
~0.3, CJK ~1), 4,000 per image, every output token the call may produce;
speech at 3 characters a second; audio at 2,000 bytes a second — so the real
cost is at most the hold by construction. The answer ceilings are data
(`MAX_OUT` in `lib/payments/paid-calls.ts`, the `max_tokens` of each seam
call), the same for everyone and never shrunk to fit a balance.

**Neither side eats an overage.** Our unit price is the provider's list price
× `MARGIN`, and the hold is that price × the call's ceilings, so a capped call's
hold covers the provider's real bill (unit test "every hold covers the
provider's real bill", `unit/paid-routes.test.ts`, for every model and kind).
If a call still costs more than its hold (pricing drift, a ceiling wrong), it
is settled at the hold (never charged past it), alerted (`credits.overage`,
feature and amounts only, plus an error line), and **the feature is paused for
everyone**: a row in `credit_feature_pause` (`0065_credit_feature_pause.sql`)
under the current `PRICES_VERSION`. A paused feature refuses before any hold
or call — HTTP **503** `{error: "credits-paused"}` with `x-lianki-credits:
paused`, and the page's notice says "temporarily unavailable, nothing was
charged" in the user's language. It resumes when the price table is fixed and
`PRICES_VERSION` bumped (a deploy): the old row no longer matches. No timer, no
manual switch to forget.

**Every account pays the same** (owner, 2026-11-10: "admin/dev permission does
not mean unlimited AI credits"). An `admin` or `dev` holder — the owner
included — takes the same hold, is charged the same, gets the same 402 with
`need` / `recommended` at a low balance, and his calls show on the credits page
like anyone's. No permission, flag or email is consulted in `takeHold` or in
`creditsCover` (the "is it offered" checks of /self-intro and "Words with AI").
Feature _visibility_ gates (`owner || flag`, e.g. `importAiOn`,
`selfIntroImportOn`) only decide whether a dev holder sees a feature before its
flag is on; they never skip the wallet. The STT rate limit `STT_MAX_OWNER`
(`lib/stt-handler.ts`) is a call cap per 10 minutes on a free feature, not credits.

**Who pays nothing.** The free features above (for everyone). A BYOK call
never reaches the server. Without D1 (the frozen Mongo backend, local dev)
nothing can be charged: the call runs and logs `credits.unmetered`.

**Not enough credits: the numbers** (owner, 2026-11-10). Every 402 from
`takeHold` carries, in the body and in headers (`x-lianki-credits-need`,
`-have`, `-recommended`), whole credits:

- `need` — the minimum to start: this call's hold;
- `recommended` — the balance to finish the whole action without stopping
  midway: a high percentile (`RECOMMEND_PERCENTILE`, P95; the owner also
  named P99) of this feature's past real per-call costs
  (`credit_ai_charge.costMicro`, settled, every user, numbers only) × the
  calls the action has left (`takeHold`'s `action.units`; 1 for a single
  call); under `MIN_SAMPLES` (20) settled calls, the hold × the calls left.
  Never below `need`. `lib/payments/recommend.ts`;
- `have` — the spendable balance.

The page-wide notice reads the headers (never the body) and adds "开始至少需要
N 积分，完成整个任务建议 R 积分（当前 H）", or "至少需要 N 积分（还差 M）"
when starting is finishing (`credits-needed.content.ts` `needLine` /
`needShort`). The Learning Partner chat's line adds the same short form (the
reply's hold and the balance, sent with `ai-credits`). /self-intro's start
note and "Words with AI" say both numbers in place; a multi-part action also
says how far it got ("已完成 X/Y 部分，充值后继续") and resumes from its
kept parts (docs/import-material.md, "Resume").

**The page.** Any 402 with that header shows one notice, on any page, in the
user's language with a "Get credits" link (`NoCreditsNotice`,
`credits-needed.content.ts`, `lib/payments/no-credits-watch.ts` — it looks at
the status and header only, never the body).

**Prices as data.** `lib/payments/prices.ts` is the one table: provider list
prices in USD (Cloudflare Workers AI pricing page, read 2026-11-09) × `MARGIN`
(1.5: card fees, retries and rounding), turned into credits at
`CREDITS_PER_USD` (150; `lib/payments/credits.ts`). So one USD of provider cost
is 225 credits.

| feature (ledger `note`)                  | route                                                                        | flag                 | provider · model                               | billing                                                                                                                                                                                                                                                                                | typical / hold                                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------- | -------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `partner.reply`                          | lianki-push hub → `DebugSessions.partnerReply`                               | `partner.ai-reply`   | Workers AI · DeepSeek v4.1 flash               | wallet (since 2026-11-05; margin since 2026-11-09). The owner's thread never goes to the model. Ledger note is empty for these.                                                                                                                                                        | ~0.2 / ≤ 10 credits                                                                               |
| `read.gloss`                             | `/api/read/[id]/gloss`, `grade`, `make-cards`, `word-session`, `batch-grade` | —                    | Workers AI · DeepSeek                          | wallet. Deck meanings and `word_gloss` hits are free; `own: true` (BYOK) asks no model of ours. A tap refused → 402; a bulk call leaves the words without a meaning.                                                                                                                   | ~0.05 per word / 2 per 40-word batch                                                              |
| `read.translate`                         | `/api/read/[id]/translate`                                                   | —                    | Workers AI · DeepSeek                          | wallet; a `read_translation` hit is free                                                                                                                                                                                                                                               | ~0.1 / 1                                                                                          |
| `vibe.translate`                         | `/api/vibe/[id]/translate`, the reader on a /vibe doc                        | `read.vibe`          | Workers AI · DeepSeek                          | wallet; a line already translated is free                                                                                                                                                                                                                                              | ~0.1 / 1                                                                                          |
| `read.polish`                            | `/api/read/[id]/polish`                                                      | —                    | Workers AI · DeepSeek                          | wallet, one hold for the whole document                                                                                                                                                                                                                                                | ~0.3 per 1,000 characters / up to its chunks' max                                                 |
| `read.live-polish`                       | `/api/read/[id]/polish-live`                                                 | `read.live-polish`   | Workers AI · DeepSeek (or `READ_POLISH_MODEL`) | wallet                                                                                                                                                                                                                                                                                 | ~0.2 / 1–3                                                                                        |
| `self-intro.import`                      | `/api/self-intro/import`                                                     | `self-intro.import`  | Workers AI · DeepSeek                          | wallet                                                                                                                                                                                                                                                                                 | ~0.5 / ≤ 9 (40,000 characters + 4 images)                                                         |
| `self-intro.followup`                    | `/api/self-intro/followup`                                                   | `self-intro.import`  | Workers AI · DeepSeek                          | wallet                                                                                                                                                                                                                                                                                 | ~0.2 / 1                                                                                          |
| `words.import-ai`                        | `/api/import/ai` (the /words Import panel, "Words with AI" on a stored file) | `words.import-ai`    | Workers AI · DeepSeek                          | wallet: one hold per chunk call, settled at its real cost; a failed call or a chunk with no rows keeps nothing; each hold a hard cap; out of credits midway: 402 with completed / total, the paid chunks kept for a resume                                                             | ~0.6 per 6,000 characters / ~3 per chunk; a full file (10 chunks + 4 images) ≤ 23; offered from 2 |
| `words.tts`                              | `/api/words/tts` (cache miss only)                                           | —                    | Workers AI · MeloTTS / Aura-2                  | **free** — owner, 2026-11-09 (card o3): word read-aloud stays free for now; each miss logs what it cost us (`credits.free`, `why: "free-feature"`)                                                                                                                                     | MeloTTS ~0.001 per clip; Aura-2 ~0.7 per 100 characters                                           |
| `speech.stt`                             | `/api/debug/stt` (the chat's mic, voice mode)                                | `words.voice-mode`   | Workers AI · Whisper turbo                     | **free** — owner, 2026-11-09 (card o3): the microphone stays free for now; each transcription logs what it cost us. The owner's local STT (his Mac) costs nothing                                                                                                                      | ~0.03 per 15 s utterance                                                                          |
| `ai-sentences`                           | `/api/ai-sentences/generate`, `/new-word`                                    | — (`/lab/ai-vocab`)  | Workers AI · Llama 3.3 70B                     | wallet                                                                                                                                                                                                                                                                                 | ~0.3                                                                                              |
| `polyglot.translate`, `polyglot.tts`     | `/api/polyglot/*`                                                            | — (`/lab/polyglot`)  | Workers AI · Llama / MeloTTS                   | wallet                                                                                                                                                                                                                                                                                 | ~0.3 / ~0.01                                                                                      |
| `self-intro.translate`, `self-intro.tts` | `/api/self-intro/translate`, `/tts`                                          | —                    | Workers AI · Llama / MeloTTS                   | wallet                                                                                                                                                                                                                                                                                 | ~0.3 / ~0.01                                                                                      |
| `roadmap.generate`                       | `/api/roadmap/generate`                                                      | —                    | Workers AI · Llama                             | wallet                                                                                                                                                                                                                                                                                 | ~1                                                                                                |
| `blog.translate`                         | `/api/translate` (blog post, any signed-in user; the result is shared)       | —                    | Workers AI · gpt-oss-120b                      | wallet: held before the stream, settled when it ends; a translation already in the PR is free                                                                                                                                                                                          | ~5 per post                                                                                       |
| `voice.cloud`                            | `/api/voice/tts` (Li's read-aloud in a `google:` / `azure:` voice)           | `voice.cloud-voices` | Google Cloud TTS / Azure Speech                | wallet: held and charged at the voice tier's list price per million billed characters (the SSML body) × `MARGIN` (`PROVIDER_TTS_USD_PER_M`: Google Standard $4, WaveNet / Neural2 $16, Chirp $30, Studio and unknown names $160; Azure neural $16, HD $30); no key = 503, nothing held | Standard ~0.09, WaveNet ~0.36 per 100 characters / the same                                       |
| `tts`                                    | `/api/tts` (legacy; no page calls it)                                        | —                    | Workers AI · MeloTTS                           | **free** with word read-aloud (2026-11-09); cost logged                                                                                                                                                                                                                                | ~0.01                                                                                             |

Not charged, on purpose (no provider bill per call):

| path                                                                            | why free                                                             |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| recorded word clips (`workers/voice`, R2 `voice/`)                              | pre-rendered once by the owner; R2 egress is free                    |
| cached TTS (`tts/` in R2), `word_gloss`, `read_translation`, `vibe_translation` | the answer is stored; no provider call                               |
| `/api/import/youtube`                                                           | YouTube Data API: free quota, no money                               |
| Google Drive / Docs (`/connections`, `read.gdoc-stream`)                        | Google APIs on the user's own OAuth token; no per-call bill          |
| `/library` catalogue (`library.catalogue`)                                      | public-domain texts cached in R2; no provider call                   |
| BYOK (`byok.sync`)                                                              | the user's own key, from their browser                               |
| the inbox (R2 storage and operations, `lib/inbox/charge.ts`)                    | metered and logged, not yet debited: cents per GB-month; a follow-up |
| owner-only tools (`/dev/*`, the owner's STT bench `?model=`, local STT)         | the owner pays (local STT is still booked in the cost ledger below)  |

### Cost ledger (`/dev/costs`)

Owner, 2026-11-11: a free feature charges nothing, but **its real cost is
booked per account**, and an administrator sees who consumed what. Users keep
seeing only what they are charged (`/membership/credits`); this view is
admin-only. Rules in `lib/payments/cost-ledger.ts`, the API in
`lib/payments/costs-route.ts` (`GET /api/dev/costs`), the page in
`app/(app)/dev/costs/`, the table in `db/migrations/0072_cost_ledger.sql`.

- **`cost_ledger`**: one row per served free call — `user_id` (the account
  id, `''` for a guest), `feature`, `usd_micro` (the provider's cost in
  millionths of a USD, REAL so a MeloTTS clip's few millionths are kept),
  `units` (audio seconds for speech to text, characters for speech), `day`
  (JST, YYYY-MM-DD) and `at`. Indexed by (day, user) and (feature, day). No
  text, no audio, no email.
- **Who books.** `freeCall` (`lib/payments/paid-calls.ts`) takes the payer
  (`{userId, db, units}`) from every caller: `/api/words/tts` (cache misses;
  recorded clips and cached audio cost nothing and are not booked),
  `/api/tts`, `/api/debug/stt`. The cost booked is our price ÷ `MARGIN` — the
  provider's list price — so free and paid add up in the same unit. The
  lianki-voice Worker serves recorded clips (no provider bill) and passes
  misses on to `/api/words/tts`, which books them, so it books nothing itself.
- **Never in the user's way.** The booking runs after the call, under the
  request's `waitUntil` (awaited only where there is none: dev, tests). A
  failed write logs `cost.book.failed` (the feature and the error only) and
  the user's call answers as if nothing happened (unit test "a ledger failure
  never breaks or fails the user's call"). Without D1 nothing is booked.
- **Lianki's speech server, as a cloud service.** The owner's Mac STT
  ([local-stt.md](local-stt.md)) streams from the page straight to the Mac;
  no utterance touches lianki.com on its own. So the page reports each one it
  was served: the chat mic (`MicButton.tsx`, `reportLocalStt`, every final the
  Mac answered, filtered or not) and /vibe (`served` in `lib/vibe/session.ts`)
  POST `{audioMs}` to `/api/debug/stt/local` (same-origin JSON, signed in,
  `LOCAL_STT_MAX_REPORTS` per 10 min, fire and forget). The server books
  feature `speech.stt.local`: `audioMs` clamped to one utterance
  (`LOCAL_STT_MAX_AUDIO_MS`, 30 s) × the config key
  **`stt.local.costPerMinUsd`** (default 0.000513, Workers AI whisper turbo's
  list price per audio minute, [workers-ai.md](workers-ai.md); editable at
  `/dev/config`). Not booked: a box token's chat (box tokens never reach
  `/api/debug`), and an utterance whose page closed before the report left
  (`keepalive` covers most).
- **The page** (`isAdmin`, 404 otherwise, page and API): a JST day range
  (default the last 30 days, at most `COSTS_MAX_DAYS`); totals; **by
  feature** and **by day** (a VirtualList with a seal-red bar per day); **by
  account**, dearest first — the top three marked — as a VirtualList loading
  `lists.batchSize` rows as it scrolls, each with its display name and
  account id (never an email). Every table shows free cost and paid cost side
  by side, plus what paid features charged (credits) and the calls. The paid
  side is read from `credit_ai_charge` (settled rows by `settledAt`, JST):
  `costMicro` ÷ `CREDITS_PER_USD` ÷ `MARGIN` is its provider cost; the feature
  is the charge key's prefix (`<feature>:<userId>:…`; none = a Learning
  Partner reply). Strings: `costs.content.ts` (`dev-costs`, 16 locales with
  context lines); the page name is `costs` in `dev-pages`.
- **Per day and per hour, by service** (owner, 2026-11-11;
  `lib/payments/cost-buckets.ts`). `?view=days` is a day × feature matrix
  (every JST day of the range, empty ones too); `?view=hours&hours=N` an
  hour × feature matrix of the range's last N JST hours (default 48, at most
  `COSTS_MAX_HOURS` = 168, never after the current hour). An hour is the
  `at` / `settledAt` time + 9 h cut to `YYYY-MM-DDTHH` (JST has no daylight
  saving). The hourly free query is bounded by the indexed `day` column as
  well as `at`, the paid one by the `settledAt` index, so no new index. The
  page shows both as tables (`CostMatrix.tsx`: rows a VirtualList, columns
  the services dearest first, row sums right, column sums on top; each cell
  free cost over paid cost on a seal-red heat ground, `heat.ts`, AA text on
  every level in light and dark) and as **charts** (`CostCharts.tsx`, inline
  SVG, no library): cost per day and per hour stacked by service (top five,
  the rest "other") or free vs paid, and the top ten accounts' free/paid
  bars. Each red/gold series carries its own pattern and a legend label, so
  colour is never alone; hover, tap or ←/→ shows a bar's exact values; the
  chart points at its table with `aria-describedby`.
- Tests: `unit/cost-ledger.test.ts` (booking, failure, the speech-server
  route, aggregation, the API's 404); `unit/cost-buckets.test.ts` (JST hour
  and day edges, no DST, the hour window cap, the matrix sums, both views and
  their 404, the heat scale's AA); QA `scripts/qa/qa-costs.mjs` (suite
  `costs`: non-admin 404 on the page and every view, a speech-server report
  booked, the account by name with no email, both matrices and the charts, a
  tapped bar's values, 360 px light + dark).

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

| id                | kind     | methods                                    | env (secrets)                                                                         | state                                                        |
| ----------------- | -------- | ------------------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `stripe`          | checkout | card, Alipay, WeChat Pay                   | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (+ flag `payments.stripe.live` for live) | implemented — test mode until live ([above](#turning-it-on)) |
| `komoju`          | checkout | card, konbini, PayPay, Alipay, WeChat Pay  | `KOMOJU_SECRET_KEY`, `KOMOJU_WEBHOOK_SECRET` (+ flag `payments.komoju.live` for live) | implemented — test mode until live (below)                   |
| `payjp`           | checkout | card (3-D Secure, checkout-policy.ts)      | `PAYJP_SECRET_KEY`, `PAYJP_WEBHOOK_TOKEN`                                             | slot                                                         |
| `paddle`          | checkout | card, PayPal, Apple Pay                    | `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`                                             | slot                                                         |
| `usdt`            | checkout | USDT TRC-20 / ERC-20 (QR)                  | `USDT_GATEWAY_API_KEY`, `USDT_GATEWAY_WEBHOOK_SECRET`                                 | slot                                                         |
| `afdian`          | grant    | 爱发电 (Alipay, WeChat Pay)                | `AFDIAN_USER_ID`, `AFDIAN_API_TOKEN`                                                  | slot                                                         |
| `patreon`         | grant    | Patreon                                    | `PATREON_WEBHOOK_SECRET`                                                              | slot                                                         |
| `github-sponsors` | grant    | GitHub Sponsors (as credits, not Pro days) | `GITHUB_SPONSORS_CREDITS`                                                             | slot                                                         |

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

| piece                         | where                                                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| limits (one object)           | `lib/referrals/email-invite-config.ts` (`EMAIL_INVITE`, `INVITE_MAIL_SENDER`)                                                             |
| send, status, opt-out, tokens | `lib/referrals/email-invite.ts`; routes `app/api/invite/email/route.ts`, `app/api/invite/email/opt-out/route.ts`                          |
| the template (one module)     | `lib/referrals/invite-mail.ts` + strings `lib/referrals/invite-mail.content.ts` (16 locales, context lines)                               |
| preview, sends nothing        | `previewInviteMail()` / `renderFor()`; admin-only `GET /api/dev/invite-mail-preview?format=html\|text\|json&locale=` renders his own mail |
| UI                            | `app/(app)/membership/EmailInviteBox.tsx`; opt-out page `/membership/invite-opt-out`                                                      |
| tables                        | `db/migrations/0061_invite_email.sql`: `invite_email_log`, `invite_email_recipient`, `invite_email_suppression`                           |
| bounces, complaints           | `lib/resend-webhook.ts`; route `app/api/email/resend-webhook/route.ts`                                                                    |
| tests                         | `unit/email-invite.test.ts`, `unit/resend-webhook.test.ts`; QA `scripts/qa/qa-email-invite.mjs` (suite `email-invite`)                    |

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
- **No address in the invite tables**: `recipientHash` = SHA-256 of the
  canonical address; `recipientMasked` (`a***@example.com`) only for the
  inviter's own history. Keyed by user id, so nothing moves on an email change
  (not in `EMAIL_KEYED_TABLES`). No log line holds an address. Since
  2026-11-09 the send log (`mail_log`) does keep it, by owner decision:
  developers only, deleted with the inviter's account.
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
- **Send log**: every invite mail also has a row in `mail_log` with the
  address (dev-only, /dev/mails; [mail-templates.md](mail-templates.md), "Send
  log"); its Resend there goes through `inviteOne`, under every limit below.
- **Bounces and complaints**: Resend's webhook, `POST /api/email/resend-webhook`
  (`lib/resend-webhook.ts`; Svix-signed, secret `RESEND_WEBHOOK_SECRET`; setup
  in [secrets-and-auth.md](secrets-and-auth.md), "Resend webhook"). A hard
  bounce (`bounce.type` "Permanent") or a complaint puts the address's hash in
  `invite_email_suppression` (reason `bounce` / `complaint`; a complaint
  outranks an unsubscribe or a bounce, an abuse report stays), idempotently.
  Every invite mail carries the Resend tag `invite_log=<log id>`, so a
  complaint about an invite also stamps that row's `reportedAt` and counts
  toward the inviter's report block, like the Report abuse link (matched by
  Resend's email id = `providerId` when the tag is missing). Soft bounces and
  every other event: ignored.
- **Local servers never mail**: on a localhost origin the send is a stub
  (`invite-email.stub-send`, no address), whatever `.dev.vars` holds.

### Pre-grants

Owner request 2026-11-09. An admin gives Pro days to addresses that have **no
account yet**, so the days are waiting when that person signs up.

| piece                                | where                                                                                                                                                                                                                         |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| parse, preview, apply, revoke, claim | `lib/referrals/pregrant.ts`                                                                                                                                                                                                   |
| route (admin only, 404 otherwise)    | `app/api/dev/pregrants/route.ts`: GET list, POST `preview` / `apply`, DELETE `?id=`                                                                                                                                           |
| UI                                   | the "Pre-grant" panel on `/dev/users` (`PregrantPanel.tsx`); open grants are rows of the users table tagged pending (or lapsed), each with Revoke. Strings: `pregrant.content.ts` (`dev-pregrant`, 16 locales, context lines) |
| table                                | `db/migrations/0063_pending_membership.sql`: `pending_membership`                                                                                                                                                             |
| the claim                            | better-auth `databaseHooks.session.create.after` (every sign-in) and `user.update.after` (an address verified later), `auth-impl.ts`                                                                                          |
| tests                                | `unit/pregrant.test.ts`; QA `scripts/qa/qa-pregrant.mjs` (suite `pregrant`)                                                                                                                                                   |

- **The list**: one address per line, or CSV `email,days,note` (the note may
  hold commas; a header line and `#` comments are skipped). Days and note fall
  back to the panel's fields. Optional: a date after which an unclaimed grant
  lapses (the end of that day, Japan time). At most 500 lines, 1–3660 days.
- **Preview** (writes nothing): `ok` (will wait), `invalid`, `duplicate` (the
  same canonical address earlier in the list), `pending` (already has an open
  grant), `account` (an account with that canonical address exists). For an
  `account` row the admin picks **Grant now** — `grantPro` at once, reason
  `pregrant-direct`, refId `pregrant-direct:<apply key>:<userId>`, so a retried
  click grants once — or **Skip** (the default). No pending row is made for an
  address that has an account. The server runs the preview again on apply and
  trusts nothing the page sends but the choices.
- **Stored**: the address as typed (lowercased) — the admin page has to show the
  list, and it is the owner's own list — plus `email_hash` = SHA-256 of
  `pregrant:` + the canonical address, which is what matching uses. A partial
  UNIQUE index allows one open (unclaimed, unrevoked) grant per person.
- **The claim**: on sign-in, if the account's email is **verified**, every open
  and unexpired row for its canonical address is taken by one conditional
  UPDATE (`claimed_at`, `claimed_user_id`), then granted through `grantPro`: a
  `membership_grant` row, reason `pregrant`, refId `pregrant:<row id>` —
  UNIQUE, so once only — and `proEndsAt` extended in SQL, stacking on running
  Pro. An unverified address never claims (anyone can type any address at
  sign-up; OAuth and the emailed code verify it, a local password sign-up does
  not). A revoke or expiry landing between the read and the take wins; a grant
  that fails outright puts the row back for the next sign-in. Aliases share
  one grant: the first verified account of that person takes it.
- **Revoke**: only an open row; a claimed one stays claimed.
- **Audit**: `security_audit` kinds `pregrant.create` / `pregrant.revoke`
  (actor the admin, subject the row id, detail a masked address and the days),
  `pregrant.direct` (subject the account), `pregrant.claim` (actor the account).
- **Email change**: not in `EMAIL_KEYED_TABLES`. The `email` column is the
  address the admin typed, not an account's key: no account owns the row until
  it is claimed, and then it is tied to `claimed_user_id`, which never changes.
- No charging and no Stripe: days only, through the same path as gift codes.

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
