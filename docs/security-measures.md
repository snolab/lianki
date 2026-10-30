# Security measures

What Lianki does against the threats a card-payment merchant must cover — the
items of the Japanese EC merchant security guideline (クレジットカード・セキュリティ
ガイドライン, 附属文書20) that payment providers ask merchants to declare. Each
section says what is in place, where it lives, and what is left to the owner.

Architecture in one line: `lianki.com` is a Cloudflare Worker (OpenNext build of
`app/**`) on D1; sign-in is Google/GitHub OAuth, an emailed 6-digit code, or a
passkey — there is no password login in production.

## 1. Admin access (脆弱性対策 ①)

**Admin surfaces** (audited 2026-10-30):

| surface                                   | what                                                  |
| ----------------------------------------- | ----------------------------------------------------- |
| `/dev/*` pages                            | users, friends, gift codes, membership grants, roadmap, A/B |
| `/api/dev/*`                              | whoami, log, friends, state-tree, membership, gift-codes |
| `/api/version/debug/control` (lianki-push) | remote-eval/chat controller: useless until the owner approves it on a page, or holds a grant |
| `POST /api/version/progress` (lianki-push) | agent progress reports: `Authorization: Bearer PROGRESS_TOKEN` |
| Cloudflare, GitHub, Resend, payment dashboards | the providers' own consoles                     |

`/api/debug/identity` and `/api/debug/stt` are not admin: any signed-in user
reaches their own data there. Gift-code management moved from
`/api/gift-codes` to `/api/dev/gift-codes` so every owner-only API is under one
prefix; redeeming stays at `/api/gift-codes/redeem`.

**Layer 1, in the app.** Every `/dev` page and `/api/dev` route checks
`isOwner()` (`lib/owner.ts`, `OWNER_EMAILS` in `wrangler.jsonc`) and answers
**404** to everyone else, so the surface is not even discoverable. Unset
`OWNER_EMAILS` fails closed. `unit/security.test.ts` fails if a `/dev` page or
`/api/dev` route is added without the gate; `qa:api` checks a signed-in
non-owner gets 404 from each.

**Layer 2, at the edge: Cloudflare Access** on `lianki.com/dev` and
`lianki.com/api/dev` (each covers its subpaths), allowing only the owner
emails. Prepared, not applied — `scripts/ops/cloudflare-access.ts`:

```bash
bun scripts/ops/cloudflare-access.ts --dry-run   # the policy and app it would create
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… bun scripts/ops/cloudflare-access.ts
bun scripts/ops/cloudflare-access.ts --verify    # /dev/users must now redirect to Access
```

The token needs **Account · Access: Apps and Policies · Edit** (the CI deploy
token lacks it). Access needs a login method in Zero Trust → Settings →
Authentication: One-time PIN works with no setup; Google or GitHub as an IdP
gives their 2FA. Consequences:

- The owner signs in to Access once per browser per session (24 h). Until
  then, the owner-only fetches a debug page makes (`/api/dev/log`,
  `/api/dev/state-tree`, `/api/dev/friends`) are redirected and fail quietly.
- `lianki-push` calls `/api/dev/whoami` over its service binding, which does
  not go through the zone, so Access does not touch it.
- The lianki-push controller endpoints are not under Access: agents' CLIs
  reach them with grants or the progress token, and a controller can do
  nothing without the owner's approval on a signed-in page.

Alternative to Access if the owner has a fixed IP: a WAF custom rule (Security
→ WAF → Custom rules), action Block:

```
(http.host eq "lianki.com" and (starts_with(http.request.uri.path, "/dev") or starts_with(http.request.uri.path, "/api/dev/")) and not ip.src in {203.0.113.10})
```

**Admin 2FA.** The admin identity is the owner's Google/GitHub account, and
the provider dashboards (Cloudflare, GitHub, Resend, the payment provider)
each have their own login — 2FA must be on for every one of them (owner
checklist below).

**Account lockout.** There is no password form to lock: production sign-in is
OAuth (the provider's lockout applies), an emailed code, or a passkey. The
code and passkey endpoints are limited by `lib/security/auth-guard.ts`, wired
into better-auth as a plugin (`lib/security/auth-plugin.ts`), with counters in
D1 (`auth_throttle`, `db/migrations/0016_security.sql`) — not in Worker memory,
which is per isolate and could be walked around:

| what                                    | limit                                                   |
| --------------------------------------- | ------------------------------------------------------- |
| wrong codes for one **account**         | 10 failures in 15 min → account locked **30 min** (also gets no new codes) |
| failed code or passkey checks from one **IP** | 10 failures in 15 min → IP locked **30 min**      |
| one code                                | dies after 5 wrong tries (better-auth `allowedAttempts`) |
| code mails                              | 5 per address, 20 per IP, per 15 min                     |

A locked request gets **429** with `Retry-After`. A successful sign-in clears
the account's failures. This meets PCI DSS v4.0 8.3.4 (≤ 10 attempts, ≥ 30
minutes). Account keys are a SHA-256 of the address, never the address. The
dev-only password path (`/sign-in/email`, off in production) is not counted.

## 2. Public directory (脆弱性対策 ②)

The Worker serves only the build's static assets (`.open-next/assets`: the
contents of `public/` plus Next's client chunks). `scripts/security/check-public-dir.ts`
fails on any env file, `.dev.vars`, key or certificate, database or dump,
archive, log, credential-looking content, or source map of server code. It
runs on `public/` in CI (`ci.yml`, unit job) and on `.open-next/assets` in the
deploy workflow before `wrangler deploy`. gitleaks scans the whole history in
CI and the pre-commit hook scans each commit.

**Uploads.** Nothing a user uploads is stored or served; imports are parsed in
memory. `lib/security/upload-policy.ts`:

| endpoint           | accepts                                   | max    |
| ------------------ | ----------------------------------------- | ------ |
| `/api/import/anki` | `.apkg`, and must start with the zip magic bytes | 100 MB |
| `/api/import/yaml` | `.yaml` / `.yml` (or a raw YAML body)     | 10 MB  |

Every other import takes JSON validated by zod.

## 3. Vulnerability checks (脆弱性対策 ③)

`.github/workflows/security.yml`:

- **Dependency audit** on every PR, every push to `main`, and weekly:
  `bun scripts/security/audit-report.ts` runs `bun audit` for production
  dependencies and for everything. It fails on an unwaived **critical**
  advisory in a production dependency. Not a required check, so a newly
  published advisory never blocks an unrelated deploy — a red run is a task.
- **OWASP ZAP baseline** against `https://lianki.com/en` every Monday 03:17
  UTC (and on demand: Actions → Security scans → Run workflow). Baseline means
  spider + passive checks only — headers, cookies, information leaks — no
  attack payloads, so it is safe against production. Tuning in `.zap/rules.tsv`.

**Reading the reports.** Open the run → Artifacts:

- `dependency-audit/audit-summary.md`: counts per severity, then each
  blocking advisory with its package, affected range and GHSA link. Fix by
  upgrading (`bun audit fix`, or the parent package). If an advisory cannot
  reach Lianki (a dev-only tool, an unused plugin), waive it in
  `security/audit-waivers.json` — `{ "ghsa", "reason", "until" }` — with a
  reason and an expiry no more than 90 days out. The full JSON is beside it.
- `zap-baseline-report`: `report_html.html` (open in a browser) lists alerts
  by risk (High / Medium / Low / Informational) with the URLs and evidence.
  High or Medium: fix, or justify and add `<id> IGNORE (reason)` to
  `.zap/rules.tsv`. `report_json.json` is the same for diffing runs.

**Secure coding.** D1 queries are prepared statements with bound parameters
(no string-built SQL); React escapes output; request bodies are validated with
zod; webhooks verify HMAC signatures in constant time; secrets live only in
Worker secrets. Every change reaches `main` through a pull request and must
pass the CI gates (typecheck, unit tests, gitleaks, `qa:all`) first.

## 4. Antivirus (脆弱性対策 ④)

The service runs on Cloudflare Workers: V8 isolates with no operating system,
file system, shell or long-running process of Lianki's own. There is nothing
to install signature-based antivirus on, and nothing for malware to persist
in — each deploy replaces the code wholesale from the reviewed `main`
commit, built in GitHub Actions. Uploaded files are parsed in memory and never
stored or served (section 2). Cloudflare is responsible for the host systems
(SOC 2 Type II, ISO 27001, PCI DSS Level 1 service provider).

Where antivirus does apply is the **developer machine** that holds the
deploy credentials. That is the owner's decision: macOS's built-in XProtect /
XProtect Remediator (signature updates automatic) is the baseline; installing
an endpoint product with scheduled full scans makes the item unconditionally
true.

## 5. Card testing / credit master (脆弱性対策 ⑤)

Checkout start (`POST /api/payments/checkout`), before any payment provider is
called (`lib/payments/checkout-guard.ts`):

1. **Rate limit**: 5 starts per 10 minutes per user and per IP (D1 counters;
   failed attempts count too). Over it: 429.
2. **Cloudflare Turnstile**: the membership page renders the widget (same
   `NEXT_PUBLIC_TURNSTILE_SITE_KEY` as sign-in) and the server verifies the
   token with `TURNSTILE_SECRET_KEY`. Without the secret, production refuses
   checkout (503) rather than run unprotected.
3. **3-D Secure on every card payment**: `lib/payments/checkout-policy.ts`
   holds the provider-agnostic rule (`threeDSecure: "required"`), and each
   provider adapter must apply it — Stripe as
   `payment_method_options.card.request_three_d_secure = "any"` (unit-tested on
   the wire). A PAY.JP adapter does not exist yet; when it is written it must
   create charges with `three_d_secure: true` (`payjpThreeDSecure()`), and
   fulfil only a charge whose 3DS result succeeded. Checking that is part of
   the adapter's tests.

Checkout requires a signed-in account, so the sign-in limits above apply too.

## 6. Unauthorised sign-in (不正ログイン対策)

- **Login notification (⑤)**: a sign-in from a browser the account has not
  used before sends the account an email — time (UTC), approximate location
  (Cloudflare's IP geolocation) and the user agent — with what to do if it was
  not them. A browser is recognised by `lk_device`, a random httpOnly cookie
  (2 years); only its SHA-256 is stored (`known_device`). The sign-up itself is
  not announced. `lib/security/login-notice.ts`; sent through Resend
  (`RESEND_API_KEY`, `EMAIL_FROM`) after the response (`waitUntil`), so it never
  slows or fails a sign-in.
- **Attempt limits (④)**: section 1, "Account lockout".
- **Second factor (②)**: passkeys (a device-bound key plus the device's
  biometric or PIN), and OAuth with the provider's 2FA. The emailed code
  proves control of the mailbox.

## Owner checklist

Things this repo cannot do by itself:

- [ ] Apply Cloudflare Access (section 1) and run `--verify`.
- [ ] Confirm 2FA on Google, GitHub, Cloudflare, Resend and the payment provider accounts.
- [ ] Decide on endpoint protection for the dev machine (section 4).
- [ ] Turnstile: `TURNSTILE_SECRET_KEY` (Worker secret) and the
      `NEXT_PUBLIC_TURNSTILE_SITE_KEY` repo variable already exist for sign-in;
      in the Turnstile dashboard, make sure the widget's hostnames include `lianki.com`.
- [ ] Read the first weekly ZAP report and the dependency audit; fix or waive.
