# Feature flags

Switches the owner turns on and off himself at **`https://lianki.com/dev/flags`**,
with no deploy and no secret change.

| piece                      | where                                         |
| -------------------------- | --------------------------------------------- |
| registry (key, description, default, `requires`) | `lib/flags.ts`        |
| prerequisite checks        | `lib/flag-prereqs.ts`                         |
| read / write, cache        | `lib/flags-store.ts`                          |
| tables                     | `db/migrations/0027_feature_flags.sql`: `feature_flags` (key, enabled, updated_at, updated_by) and `feature_flag_log` (every change) |
| toggle page / API          | `app/(app)/dev/flags/` (`FlagCard.tsx`: one switch, its reasons), `app/api/dev/flags/route.ts` |
| tests                      | `unit/flags.test.ts`, `unit/flag-prereqs.test.ts` |

## Rules

- **Only registry keys exist.** `setFlag` refuses any other key (400 on the
  API); a stored row for a key no longer in the registry is ignored.
- **Every default is OFF**, and so is a flag that cannot be read (a D1 error,
  the Mongo backend, no request context). A failed read is logged
  (`flags.read-failed`) and not cached, so the next request tries again.
- **Cache: 30 s per isolate** (`FLAG_CACHE_MS`). `readFlags()` costs one small
  query per isolate per 30 s; concurrent misses share it. A change made at
  `/dev/flags` reaches every request within 30 s. The isolate that wrote it
  drops its cache at once. The bound holds for a slow D1 too: a request never
  joins a shared read that started 30 s or more ago, and a read whose answer
  arrives past the window is not acted on — it reads as all off
  (`flags.read-stale`).
- **Owner only.** The page and `/api/dev/flags` answer 404 to anyone but
  `OWNER_EMAILS` (the admin gate, [security-measures.md](security-measures.md)
  §1; `unit/security.test.ts` enforces it), and sit under Cloudflare Access's
  `/dev` and `/api/dev` paths once that is applied.
- **CSRF**: `POST /api/dev/flags` must be a same-origin JSON `fetch` —
  `Content-Type: application/json`, an `Origin` naming this host, and
  `Sec-Fetch-Site: same-origin` when sent (`lib/security/same-origin.ts`);
  anything else is 403 before the body is read. On top of the SameSite=Lax
  session cookie every `/dev` action already relies on.
- **Logged**: each change writes the row and a `feature_flag_log` entry (who,
  to what, when) in one D1 batch, and a `flags.set` line to `wrangler tail`.
  The page shows the newest 50, times in JST.

## Flags now

| key                    | on means                                                       |
| ---------------------- | -------------------------------------------------------------- |
| `payments.stripe.live` | Stripe takes real money (also needs an `sk_live_` key)         |
| `payments.komoju.live` | KOMOJU takes real money (also needs an `sk_live_` key)         |
| `words.voice-mode`     | everyone gets the /words voice commands switch (off: the owner's preview only) — [voice-mode.md](voice-mode.md) |
| `read.reader-v2`       | everyone gets reader v2: sentence review units, swipe grades, synced position, notes, exposure log (off: the owner only) — [books-plan.md](books-plan.md), "Review units" |
| `stt.polish-off`       | the agent can no longer polish the owner's voice lines; the chat keeps only what STT heard (off: polish from context only) — [dev-debug-widget.md](dev-debug-widget.md), "Agent edits of voice messages". Read by lianki-push's hub over the `DebugSessions.flag()` RPC, uncached |
| `connections.google`   | every signed-in user gets /connections (Google Drive, `drive.file`) and the private Google Docs import on /read (off: the owner only) — [connections.md](connections.md) |
| `partner.ai-reply`     | every signed-in user but the owner gets the Learning Partner chat on every page, answered by DeepSeek on Workers AI (off: debug-mode friends only, lanes answer) — [partner-ai.md](partner-ai.md). Read by the hub over `DebugSessions.flag()`, cached 30 s there |
| `self-intro.import`    | every signed-in user gets the /self-intro import step: write about yourself or add files, AI lists facts to confirm; files never stored (off: the owner only) — [self-intro-import.md](self-intro-import.md) |
| `books.catalogue`      | every visitor gets /books, the public-domain library, and can add its books to their own reading (off: the owner only) — [books-plan.md](books-plan.md), "The catalogue: /books" |
| `levels`               | every signed-in user can read their own learner level from `GET /api/levels/me` (no UI yet; study days are recorded either way) (off: the owner only, at /dev/levels) — [levels.md](levels.md) |

## Prerequisites

A flag may declare `requires` in `lib/flags.ts`: named server-side checks
(`lib/flag-prereqs.ts`, `CHECKS`), each answering `{ ok }` or `{ ok: false,
reason }`. The reason is a key in `PREREQ_REASONS` with its Chinese text (the
page is owner-only and Chinese only) and a context line, as docs/i18n.md asks.

- **Turning ON** a flag with a failing check is refused: `POST /api/dev/flags`
  answers 400 with every reason (`flags.set-refused` in `wrangler tail`), and
  `/dev/flags` greys its switch with the reasons under it.
- **Turning OFF is never checked** — every flag is a kill switch. A flag that
  is on while a check fails (on before the check existed, a secret removed
  since) keeps a usable switch and shows "条件未满足（只能关闭）".
- **Checks read presence and format only** — a key's `sk_live_` prefix, a
  length, a table in `sqlite_master` — never a value; results carry only
  `ok` and a reason key, and nothing is logged but the key.
  `unit/flag-prereqs.test.ts` asserts no value reaches a result, a refusal, a
  log line or the page.
- Payment flags (`money: true`) also show 「打开正式收款前请在 Slack 打字确认」:
  real charging still needs the owner's typed Slack confirmation.

| flag                   | requires                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `payments.stripe.live` | `stripe.live-key`: `STRIPE_SECRET_KEY` starts `sk_live_` and `STRIPE_WEBHOOK_SECRET` is set |
| `payments.komoju.live` | `komoju.live-key`: `KOMOJU_SECRET_KEY` starts `sk_live_` and `KOMOJU_WEBHOOK_SECRET` is set |
| `partner.ai-reply`     | `workers-ai.credentials` (`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_AI_TOKEN` or `CLOUDFLARE_API_TOKEN`); `ai-credits.migration` (0041: `credit_ai_charge` exists, `credit_ledger` accepts `'ai'`) |
| `connections.google`   | `google.oauth-client` (`AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`); `google.picker-key` (`pickerConfig`); `auth-secret` (`AUTH_SECRET` ≥ 32 chars, seals tokens) |

The others need nothing a check could see: `books.catalogue` works without R2
(no cache) and its tables came with the reader migrations; the rest are UI
rollouts. Add a check only for a real, observable requirement.

Turning a payment flag off is the kill switch: no new payment starts within
30 s, and payments already started are still credited —
[payments.md](payments.md), "Live mode and the kill switch".

## Adding a flag (ship a feature dark)

1. Add the key to `FLAGS` in `lib/flags.ts`: `"<area>.<feature>"`, a
   description in the owner's language (Chinese; what turning it on does), and
   `default: false`. Nothing else: no migration, no secret.
2. Gate the feature on the server:

   ```ts
   import { readFlags } from "@/lib/flags-store";
   import { flagIn } from "@/lib/flags";

   const flags = await readFlags(); // once per request; pass the snapshot down
   if (!flagIn(flags, "words.new-thing")) return notFound();
   ```

   Read once per request and pass that snapshot to everything that decides, so
   one request never sees the flag both ways. Pure helpers take a `FlagValues`
   argument (missing = off) instead of reading the store themselves, which
   keeps them unit-testable — see `stripeMode(env, flags)`.
3. A client component learns the value from the server (a prop from a server
   component, or a field in an API answer); never trust a client-sent flag.
4. Merge and deploy with the flag off: the feature ships dark. Turn it on at
   `/dev/flags` when ready (for a check first, the owner can gate on
   `isOwner` as well inside the feature).
5. Unit-test both sides of the flag.

## Removing a flag

When a feature has been on for good:

1. Delete the checks (keep the "on" branch), then the key from `FLAGS`.
2. Its `feature_flags` row stays and is ignored (unknown keys are skipped);
   no migration needed. Its log entries stay as history.
3. Payment flags are different: they are a standing kill switch, not a
   rollout — keep them.
