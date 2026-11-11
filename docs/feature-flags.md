# Feature flags

Switches the owner turns on and off himself at **`https://lianki.com/dev/flags`**,
with no deploy and no secret change.

| piece                      | where                                         |
| -------------------------- | --------------------------------------------- |
| registry (key, description, default, `requires`) | `lib/flags.ts`        |
| prerequisite checks        | `lib/flag-prereqs.ts`                         |
| read / write, cache        | `lib/flags-store.ts`                          |
| tables                     | `db/migrations/0027_feature_flags.sql`: `feature_flags` (key, enabled, updated_at, updated_by) and `feature_flag_log` (every change) |
| toggle page / API          | `app/(app)/dev/flags/` (`FlagCard.tsx`: one row, its switch and reasons; `flag-view.ts`: sections, search, filters, links), `app/api/dev/flags/route.ts` |
| tests                      | `unit/flags.test.ts`, `unit/flag-prereqs.test.ts`, `unit/flag-view.test.ts`, `unit/flag-anchor.test.ts`; browser, local D1 only: `scripts/qa/qa-flags.mjs` |

## The page

One compact row per flag: name, state and the switch, which is one tap as ever
(a payment flag still asks before turning on). Tapping the name unfolds the
description and the last change. A prerequisite's reason and the money note
stay on the folded row, because they say why the switch does nothing.

- **Sections come from the registry.** A flag's `group`, else its key's prefix.
  A group with one flag goes to 其他, so a new prefix adds no heading until it
  has a second flag. `GROUP_LABELS` (`flag-view.ts`) only gives a group its words;
  a group not listed there shows its id.
- **已全面打开 (shipped) is a view, folded by default.** A flag is there when it is
  on, reaches every user (no `audience`), is not a payment flag and fails no
  prerequisite. Nothing about it changes a value; its switch works as anywhere.
  **Set `audience` on a new flag that does not reach every user once on**, or this
  view will call it shipped.
- **Search** covers the key, an old key and the description. **Filters**: 全部 /
  开着 / 关着 (off now, whatever the default), and 7 天内改过, from the row's
  `updated_at`. A row never changed reads 从未改过（默认关）, or （默认开） for a
  default-on flag. There is no "on for me": the store has one value per flag,
  and who else a flag lets in (`|| owner`) lives in each feature's gate.
- **A link always arrives.** `#<key>`, or an old key through `FLAG_OLD_KEYS`, opens
  the section and the row, scrolls and highlights, whatever is typed or filtered.
  The row stays until the search or a filter next changes. It changes no stored
  state: the device's folded sections and filters are as they were.
- **A row just toggled stays put** until the search or a filter next changes, even
  if it no longer matches or now counts as shipped, so the switch can be undone
  with the same finger.
- **No table of contents.** Seven sections over about two screens: the headings
  and the search already do it, and a sticky bar costs phone height for good. If
  sections and screens grow, `app/(app)/books/BooksToc.tsx` is the pattern.
- Filters and folded sections are per device (`lk:pref:flags-view`,
  [ui-state.md](ui-state.md)). The search text and unfolded rows are memory.

## Rules

- **Announce with the link.** Anything shipped default-off is announced with its `https://lianki.com/dev/flags#<key>` link, which opens that flag's card.
- **Only registry keys exist.** `setFlag` refuses any other key (400 on the
  API); a stored row for a key no longer in the registry is ignored.
- **Positive flags only** (owner rule, 2026-11-10): a switch that is ON
  provides a feature, never forbids one. No `-off` / `disable` keys: a kill
  switch for something already live is a flag that is **on by default**.
- **Defaults are OFF**, but for such a flag (`default: true` in
  `lib/flags.ts`; today `stt.polish`, and `today.goal`, `words.onboarding` and
  `words.pinch-card-height`, which the owner shipped on for everyone on 2026-11-10,
  and `words.shatter`, on for `dev` holders).
  A key with no stored row reads as
  its default; a stored row always wins, either way. `closedFlags()` is what an
  unreadable store gives.
- **Unreadable is OFF**, every flag, a default-on one too (a D1 error,
  the Mongo backend, no request context). A failed read is logged
  (`flags.read-failed`) and not cached, so the next request tries again.
- **Cache: 30 s per isolate** (`FLAG_CACHE_MS`). `readFlags()` costs one small
  query per isolate per 30 s; concurrent misses share it. A change made at
  `/dev/flags` reaches every request within 30 s. The isolate that wrote it
  drops its cache at once. One cache per isolate, kept on `globalThis`: the
  build gives route handlers and page rendering each a copy of the module,
  and two module-level caches let an API route see a flag on while its page
  still 404'd for up to 30 s. The bound holds for a slow D1 too: a request never
  joins a shared read that started 30 s or more ago, and a read whose answer
  arrives past the window is not acted on — it reads as all off
  (`flags.read-stale`).
- **Owner only.** The page and `/api/dev/flags` answer 404 to anyone but
  an `admin` holder (the permission gate, [security-measures.md](security-measures.md)
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
| `words.pinch-card-height` | **on by default, everyone.** A two-finger vertical pinch on the /words list sets every card's height, from the word alone to everything on screen shown; synced as `words.cardHeight` (off: the default height, the stored choice unused) — `lib/words/row-pinch.ts` |
| `today.goal`           | **on by default.** /today: today's goal full screen — one number (cards due now, /words's own count), a progress bar (cards done since local midnight), Start to /words; gold ground and seal ink in light, seal ground and gold ink in dark; in the rail and on /home (off: 404, no links) — `lib/today/goal.ts` |
| `words.onboarding`     | **on by default.** /words plays a short animated walkthrough (tap, rate by feel, handled cards fade and can be undone, cards come back, pinch for height) once per account, then folds it into a circled "?" by the title that replays it (off: no walkthrough, no "?") — `lib/words/onboarding.ts` |
| `stt.polish`           | **on by default.** The agent may polish the owner's voice lines from their context and summarise room talk (off: the chat keeps only what STT heard, no edits or summaries) — [dev-debug-widget.md](dev-debug-widget.md), "Agent edits of voice messages". Read by lianki-push's hub over the `DebugSessions.flag()` RPC, uncached; only exactly `false` turns it off there, an unreadable answer holds edits back (logged `debug.polish-flag-unread`). Replaced the inverted `stt.polish-off` (migration 0067 carried a stored value over inverted) |
| `stt.merge`            | a spoken line that continues the last one amends it instead of adding a bubble; the agent hears the complete line, and the passage is polished once at its end; undo splits it back (off: one line per utterance) — [dev-debug-widget.md](dev-debug-widget.md), "Continuous speech amends the last line". Read by the hub over `DebugSessions.flag()`, cached 30 s there |
| `connections.google`   | every signed-in user gets /connections (Google Drive, `drive.file`) and the private Google Docs import on /reader (off: the owner only) — [connections.md](connections.md) |
| `stt.voiceprint-cloud` | **on by default** (`audience: "owner"`, plus the `dev` grant the voiceprint tickets need): the Voiceprint panel gets "Save to my account" / "Restore from my account"; with his passkey the Mac's voice features (numbers, never audio) are kept encrypted in his own account (D1 `voiceprint`), and Delete removes them there too (off: the print stays on the Mac only; /api/my/voiceprint answers 404) — [local-stt.md](local-stt.md), "Voiceprint in your account" |
| `stt.voiceprint-filter` | the owner's local STT does not transcribe or post a line that clearly is not his voice, on devices where he has enrolled; his route only, not a security gate (off: as ever, only counting what it would have stopped) — [local-stt.md](local-stt.md), "Only my voice" |
| `stt.worker`           | accounts on the /dev/stt-access allowlist stream their mic to Lianki's speech servers (SenseVoice): WebRTC first, then the WSS tunnel, then Workers AI; free, booked per utterance as `speech.stt.local`; quotas in config `stt.worker.*` (off: every public STT endpoint answers 404; the owner's own mic unchanged) — [local-stt.md](local-stt.md), "Lianki's speech servers for everyone" |
| `partner.ai-reply`     | every signed-in user but the owner gets the Learning Partner chat on every page, answered by DeepSeek on Workers AI (off: debug-mode friends only, lanes answer) — [partner-ai.md](partner-ai.md). Read by the hub over `DebugSessions.flag()`, cached 30 s there |
| `self-intro.import`    | every signed-in user gets the /self-intro import step: write about yourself or add files, AI lists facts to confirm; files never stored (off: the owner only) — [self-intro-import.md](self-intro-import.md) |
| `box.oauth`            | my-<hash> and my-<name> boxes sign in through lianki.com, each only as its bound account, and call allowlisted /api routes with a short-lived token (off: every route of it answers 404) — [box-oauth.md](box-oauth.md) |
| `my-box`               | allowlisted users (`/dev/live-frontends`) can register their own tunnel and see their own frontend at `?live=<id>`, only they, /api stays production (off: the owner only) — [custom-frontend.md](custom-frontend.md) |
| `read.gdoc-stream`     | every user gets the userscript's "Stream to Lianki" switch on Google Docs, and live readers at `/reader/<id>?streamingFrom=google-docs` (off: the owner only) — [connections.md](connections.md), "Live stream" |
| `read.live-polish`     | every user gets the AI polish of a live doc's text into a speech draft (off: the owner only) — [connections.md](connections.md), "Polish" |
| `read.youtube-songs`   | every signed-in user gets /reader → YouTube song: a YouTube link plus timed lyrics (LRC/SRT/VTT) become a /reader text, each line with a ▶ that plays that line in YouTube's own player in a popup, and word cards made from a line keep its clip: their example gets the same ▶ in /words and the reader's word review; lyrics private to the account, nothing downloaded (off: the owner only; /reader/youtube and its route 404) — [youtube-song-examples.md](youtube-song-examples.md) |
| `library.catalogue`    | **on by default, everyone.** /library, the book catalogue: browse, add to my reading, find more; its nav item, the reader's link and `/api/books/import|resolve|search` (off: 404, no links; `dev` holders keep it). Replaced `books.catalogue` on 2026-11-10 — [books-plan.md](books-plan.md), "/library and /books" |
| `books.mine`           | **on by default, everyone.** /books, My books: the user's shelf of books added from /library and imported themselves; an old /books/<lang>/<slug> link stays for a book on the shelf (off: /books and every old link go to /library, no nav item; `dev` holders keep it) — [books-plan.md](books-plan.md), "/library and /books" |
| `levels`               | every user sees their learner level: a chip by the avatar in the nav (signed in) and a level card on /my/profile (guests too), from `GET /api/levels/me`; study days are recorded either way (off: the owner only) — [levels.md](levels.md) |
| `read.vibe`            | the owner, and only the owner, can start /vibe: a conversation transcribed on his Mac into a private doc. **Off: nobody, the owner included** (no bypass) — [vibe.md](vibe.md) |
| `partner.fullscreen`   | everyone who has the Learning Partner chat gets its full-screen button: the chat fills the app; the button, Escape or Back return to the panel (off: the owner only) — [dev-debug-widget.md](dev-debug-widget.md), "Full screen" |
| `byok.sync`            | everyone sees the disabled 「同步 API key」 row (即将推出, with its warning) in Settings → 自己的 AI; nothing on the server stores a key yet (off: the owner only) — [byok.md](byok.md) |
| `import.any`           | every signed-in user gets /import → "Import a word list" and the Import button on /words: presets, or a .txt/.csv/.tsv/Excel file or paste → preview (new / already have / skipped) → a new /words list; free, no credits (off: the owner only, `importAnyOn`) — [import-material.md](import-material.md) |
| `words.import-ai`      | on: every signed-in user whose credits cover the smallest hold gets **Words with AI** on each stored file in the /words Import panel ("Any file"): the server reads the file, DeepSeek writes the word-list CSV template, then the CSV import's own preview and add, paid from their credits (hold, settle, refund). Off: holders of the `dev` permission only (`isDev`, a per-account grant), likewise with credits — [import-material.md](import-material.md) |
| `voice.cloud-voices`   | the owner (`audience: "owner"`, `isDev`): Li may read a line in a Google or Azure voice (`say --voice google:<voice>` / `azure:<voice>[/<locale>]`, or the language → voice map `voice.langVoices` at /dev/config), made on the server and played through the chat's cloud `<audio>`, paid from credits (`voice.cloud`); without a provider key nothing changes (off: no provider voice anywhere, `/api/voice/tts` answers 404) — [li-sound-hub.md](li-sound-hub.md), "Provider voices" |
| `voice.li-hub`         | on the owner's pages (debug mode), Li's sound hub logs who holds the mic and who plays (`audio-owner`, `audio-conflict`); observes only, changes no sound (off: nothing runs) — [li-sound-hub.md](li-sound-hub.md) |
| `words.shatter`        | **on by default** (`audience: "owner"`, `isDev`): on /words a slip whose countdown ended and reads "↓ back" (locked, lib/words/requeue.ts) shows cracked glass under its text, cracking once if it ends on screen; the same cracks per card (off: nobody, the owner included) — [words-session-spec.md](words-session-spec.md), "Locked slips crack" |
| `pwa.app-badge`        | the owner (`audience: "owner"`, `isDev`) gets the number on the installed app's icon (open Li asks + due cards, per the synced `notify.badge`) and its row in Settings → Notifications; nobody else (off: nobody, the owner included; a page clears any leftover badge) — [app-badge.md](app-badge.md) |
| `ext.pill-chat`        | the userscript's pill gets a **Li** button on every site: a per-site trust prompt first (default deny), then Li in the lianki.com frame; sites list in the manager's menu. First slice reuses the owner's partner ticket, so on means the owner only (`audience: "owner"`); off: no Li button anywhere, and an open attempt is refused — [userscript-li-chat.md](userscript-li-chat.md) |
| `membership.email-invite` | every Pro user gets "Invite by email" in the invite card on /membership: one friend's address → a mail with their own /i/CODE link in their account language; daily and per-address limits, unsubscribe / report, no address stored (off: admins only) — [payments.md](payments.md), "Invite by email" |

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

The others need nothing a check could see: `library.catalogue` works without R2
(no cache) and its tables came with the reader migrations; the rest are UI
rollouts. Add a check only for a real, observable requirement.

Turning a payment flag off is the kill switch: no new payment starts within
30 s, and payments already started are still credited —
[payments.md](payments.md), "Live mode and the kill switch".

## Adding a flag (ship a feature dark)

1. Add the key to `FLAGS` in `lib/flags.ts`: `"<area>.<feature>"`, a
   description in the owner's language (Chinese; what turning it on does), and
   `default: false`. Nothing else: no migration, no secret. Add `audience` if it
   will not reach every user once on, and `group` if its prefix reads badly on
   the page ("The page", above).
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

## Renaming a flag

A key is the row's primary key in `feature_flags`, and a stored row whose key
left the registry is ignored, so changing a key alone would turn its switch off
on deploy. Instead:

1. Rename the key in `FLAGS` and add `"<new>": "<old>"` to `FLAG_OLD_KEYS`
   (`lib/flags.ts`). `loadFlags` and `listFlags` take the state from the new
   key's row if there is one, whatever its value, else from the old key's. No
   migration and no write: the switch reads the same before and after the
   deploy.
2. Anything reading `feature_flags` with its own SQL has to follow the same
   order. `activeForCookie` (`lib/live-view/custom.ts`) does, with `COALESCE`.
   `flagLive` (`lib/debug-session.ts`) and `flagOn` (`lib/partner-ai.ts`) do
   not: they read `stt.polish`, `stt.merge` and `partner.ai-reply`, so renaming
   one of those means changing them too.
3. The first change at `/dev/flags` writes the row under the new key. The old
   row and its log entries stay as history. The API refuses the old key (400),
   so a `/dev/flags` tab left open across the deploy needs a reload.
4. Remove the entry and the `COALESCE` branch only once production has a row
   under the new key:

   ```bash
   wrangler d1 execute lianki --remote --command "SELECT key, enabled FROM feature_flags WHERE key = '<new>'"
   ```

   If the owner never touches the switch there is no such row. Copy it first
   with a migration, deployed before the removal:
   `INSERT INTO feature_flags SELECT '<new>', enabled, updated_at, updated_by FROM feature_flags WHERE key = '<old>' ON CONFLICT(key) DO NOTHING`.

| new key  | old key                | since      | remove when                       |
| -------- | ---------------------- | ---------- | --------------------------------- |
| `my-box` | `live.custom-frontend` | 2026-11-05 | production has a row for `my-box` |

## Removing a flag

When a feature has been on for good:

1. Delete the checks (keep the "on" branch), then the key from `FLAGS`.
2. Its `feature_flags` row stays and is ignored (unknown keys are skipped);
   no migration needed. Its log entries stay as history.
3. Payment flags are different: they are a standing kill switch, not a
   rollout — keep them.
