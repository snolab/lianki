# Mic polish API: `POST /api/mic/polish`

The standalone otoji.org/mic userscript never calls a model provider itself.
Its Worker sends the transcript here, server to server, with a Lianki API
token; we polish it with our own Workers AI and charge the token's account
credits, with a daily maximum. Owner, 2026-11-18: "since it costs, we must
cost their account credits with daily maximum".

Code: `lib/mic-polish.ts` (everything), `app/api/mic/polish/route.ts` (wiring
only). Tests: `unit/mic-polish.test.ts`.

## Contract

```http
POST https://lianki.com/api/mic/polish
Authorization: Bearer lk_…            (a token holding mic:polish)
Content-Type: application/json

{ "transcript": "so um the meeting is at three", "context": { "title": "Calendar", "site": "example.com" } }
```

- `transcript`: a non-empty string, trimmed, at most `mic.polishMaxChars`
  characters (default **8000**).
- `context`: an object or `null` (or missing): page title, site and other
  hints, used only to spell names and terms. Its JSON is at most
  `mic.polishMaxContextChars` characters (default 2000).
- The whole body is at most `mic.polishMaxBodyBytes` (default **32 KiB**,
  32768 bytes). The otoji proxy caps the body at 32 KiB and the transcript at
  8000 characters itself, so these defaults must never be lowered under those:
  a valid proxied call would be refused. The body is read as a bounded
  stream: a `Content-Length` over the cap is refused before anything is read,
  and a body without one is cancelled the moment its byte count passes the cap
  (400 `too-long`, `field: "body"`); it is never buffered past the cap.
- **No other field.** `userId`, `model`, `price`, `max_tokens` or anything else
  → 400 `unknown-field`. The account is the token's, the model, limits and
  price are the server's.

Answers (all `cache-control: no-store`, JSON):

| status | body                                                                           | when                                                                 |
| ------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| 200    | `{ "text": "So the meeting is at three.", "charged": 1, "basis": "reported", "daily": { "used": 4, "max": 300 } }` | polished; `charged` (whole credits kept) and `daily.used`/`daily.max` are always numbers; `basis` is `"reported"` or `"estimated"` (see Metering) |
| 400    | `{ "error": "bad-json" }`, `{ "error": "bad-input", "field" }`, `{ "error": "too-long", "field": "transcript" \| "context" \| "body" }`, `{ "error": "unknown-field", "field" }` | bad input; nothing held, no daily slot used |
| 401    | `{ "error": "unauthorized" }`                                                  | no / unknown / expired token, or no session                          |
| 403    | `{ "error": "scope", "needScope": "mic:polish", "requestUrl" }`                | the token lacks `mic:polish` (the one-scope approval link)           |
| 403    | `{ "error": "cross-origin" }`                                                  | cookie auth from another site's page                                 |
| 402    | `{ "error": "no-credits", "balance", "have", "need", "recommended", "topUp": "/membership", "dailyUsed", "dailyMax" }` | the wallet cannot cover the hold; the model never asked; slot given back |
| 404    | `{ "error": "not-found" }`                                                     | flag `mic.polish-api` off                                            |
| 429    | `{ "error": "daily-limit", "daily": { "used", "max" }, "resetAt": "<next 00:00 UTC>" }` | today's maximum reached                                   |
| 429    | `{ "error": "rate-limit", "retryAfterSec" }` + `Retry-After`                   | over `mic.polishPerMinute` for this token                            |
| 502    | `{ "error": "model-failed" }`                                                  | the model failed or answered nothing usable; refunded in full, slot given back |
| 503    | `{ "error": "not-configured" }` / `{ "error": "credits-paused" }`              | no D1 / no Workers AI; the feature paused after a price overage      |

## Auth

- **Token**: `Authorization: Bearer lk_…` with the scope `mic:polish`
  (`lib/api-tokens.ts` SCOPES; anyone may pick it at /my/preferences → API
  tokens, never a default). A token without it gets the one-scope request link.
  With an `Authorization` header the cookie is never read.
- **Session**: the signed-in cookie works only from our own pages: a request
  whose `Origin` is another host, or whose `Sec-Fetch-Site` is `cross-site` or
  `same-site`, is refused (403 `cross-origin`) before the session is read. No
  CORS headers are sent, so no other site's browser page can call it; the
  caller is the otoji.org Worker.

## Metering

`lib/payments/metered.ts`, feature `mic.polish` (usage group "stt"):
the worst case (prompt × 2 tokens per character + `min(16000, 100 + 2 ×
transcript chars)` output tokens, DeepSeek v4.1 flash × MARGIN) is held before
the call and settled after it; the rest is refunded. A thrown call or an
unusable answer (not `{"text"}` JSON, empty, or grown past 1.5× the transcript
\+ 40) is refunded in full. Admin and dev accounts pay the same.

The settle has two bases, never mixed, and the 200 answer and the log line
`mic.polish.settle` say which one was used:

- **`basis: "reported"`**: the provider's own token counts, priced with
  `textUsd`. Believed only when both `prompt_tokens` and `completion_tokens`
  are whole numbers in 0…1,000,000 and not both 0.
- **`basis: "estimated"`**: no counts, or counts that fail that check
  (negative, NaN, Infinity, not a number, absurdly large). This is an estimate
  from lengths, not a token count: `textUsd(model, ceil(promptChars × 1),
  ceil(answerChars × 1))`, capped at the hold (`micEstimateUsd`). The ratio is
  `EST_TOKENS_PER_CHAR = 1` (`lib/payments/prices.ts`), the CJK figure of the
  ratios the hold uses (Latin ~0.3, CJK ~1, emoji ~2), so Latin text is
  over-estimated rather than under-estimated. It is half the hold's ratio, and
  the answer's real length replaces the hold's maximum output, so an estimate
  is well under the hold.

## Logging

Nothing about the text is ever logged, and neither is any error message (an
upstream body can echo the transcript or a credential). A failure logs one
line, `{"event":"mic.polish.failed","kind":…}`. `kind` is one of `model-throw`
(with the provider's HTTP `status` number when it has one), `model-junk` or
`hold-failed`. A settle logs `{"event":"mic.polish.settle","basis":…}`.

## The daily maximum

Count-based: `mic.polishDailyMax` calls per account per **UTC** day (default
300), all tokens and sessions of the account together. Credits have no
account time zone in this codebase, so the day is UTC, like
`credits.signupBonusDaily`.

Why a count and not USD: every call is already size-capped, so the most a day
can cost is the count × the per-call hold, known in advance; the cap's job is
to stop a runaway loop, which a count expresses directly; and `daily.used` /
`daily.max` read plainly to the user. Credits already bound spending by the
balance.

Atomic in D1: one UPSERT on `auth_throttle` (key `mic-polish-day:<userId>`,
`windowStart` = today's 00:00 UTC) whose `DO UPDATE … WHERE windowStart < today
OR count < max … RETURNING count` either takes a slot or returns no row. Two
parallel calls cannot both take the last slot (unit test: 8 parallel calls,
max 3 → exactly 3 pass, 3 holds). A refusal by the wallet, a paused feature or
a failed call gives the slot back (`count - 1`, today's row only). No
migration: the counter table exists.

## Rate limit

`mic.polishPerMinute` (default 30) requests per token per minute (a session:
per account), counted in D1 before the body is read, separately from the daily
maximum.

## Flag

`mic.polish-api`, default **off** (it adds an auth scope; the owner turns it on
at https://lianki.com/dev/flags#mic.polish-api). Needs the Workers AI
credentials and the credits tables. Off: 404.
