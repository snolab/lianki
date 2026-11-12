# AGENTS.md — Lianki

Spaced repetition app (FSRS algorithm) on Next.js 16 + Bun. Production:
https://lianki.com (Vercel, deploys from `main`). Repo: `snolab/lianki`.

`CLAUDE.md` imports this file — edit this one.

## Hard rules

- **NEVER `git push --force`.** If histories diverge, ask how to proceed.
- **NEVER `--no-verify`** — pre-commit (seconds, staged files only) scans
  secrets, runs oxlint --fix + oxfmt, and syncs the userscript build,
  `lianki.meta.js` and `@version`; pre-push runs whole-repo lint, typecheck,
  then only the unit tests and `qa:all` suites the change reaches
  (`scripts/gate/affected.ts`; the full set, with coverage, runs in CI).
  Bypassing causes meta drift, broken userscript auto-updates, and failures CI
  finds later.
- **NEVER `git reset --hard`** to move a branch — it silently destroys
  uncommitted work. Use `git reset --keep`, which aborts instead of overwriting.
- Always bump `@version` in `lianki.user.js` when changing the userscript.
- `.env.local` and `.dev.vars` are gitignored and have no other copy — never
  delete them. An encrypted backup is proposed in
  [docs/secrets-backup-plan.md](docs/secrets-backup-plan.md) (not done yet).
- **Don't loop failed pushes.** The hook is one attempt, with no retries in code.
  If a time-sensitive suite times out, look at the load first (`uptime`); if it is
  high, wait, then retry once. See
  [docs/shipping.md](docs/shipping.md), "Admission by load".
- **Gates are permission grants.** Every owner/dev/admin check is `isAdmin` or
  `isDev` (`lib/permissions.ts`, rows in `account_permission`). Never
  `OWNER_EMAILS`, a hardcoded email, or the unused `site_role` table — not even
  for the owner. [docs/secrets-and-auth.md](docs/secrets-and-auth.md), "Permissions".
- Use owner `snolab` for every `gh` / `gh api` call. A wrong owner returns a
  plan-gated 403 that misleadingly reads as "branch protection is off".

- **Defaults in code, live values in the DB.** A user-meaningful number, text
  or icon is a key in `lib/config.ts` read with `cfg()` / `publicCfg()`, never a
  bare constant; the code holds only its default.
  [docs/config-store.md](docs/config-store.md).

## Commands

```bash
bun run dev            # Next.js :3000   (bun run dev:db first for local Mongo)
bun run typecheck      # tsgo --noEmit
bun test unit/x.test.ts  # one test file, no queue
bun run test:unit      # whole unit suite, starts at once (CI adds -- --coverage)
bun fix                # oxlint --fix + oxfmt
bun run lint           # oxlint + oxfmt --check, whole repo (pre-push and CI run it)
bun run qa:all         # full integration gate — merge queue (sharded) + Full QA after merges; time-sensitive suites wait for load-based admission
bun scripts/gate/affected.ts plan  # what pre-push runs for this change, and why (LIANKI_GATE_FULL=1 push: everything)
bun scripts/ship.ts    # land the current commit on main via PR + auto-merge
```

Agent lanes talk to the owner and the state tree through **one CLI**,
`lianki-dev` (`bun scripts/dev/lianki-dev.ts`), not ad-hoc
`eval.ts`/`progress.ts` calls: `lianki-dev say --as <lane> "…"`, `ask`,
`inbox`, `listen`, `progress`, and `lianki-dev doctor` when something fails.
A lane never pairs. [docs/lianki-dev-cli.md](docs/lianki-dev-cli.md).
**Lanes chat with their own lane token**: the owner makes one per lane at
lianki.com/my/preferences → API tokens (name = the lane, chat permissions, an
expiry) and it is handed to that lane as `LIANKI_TOKEN`; then `lianki chat
say|ask|read|listen` (or `lianki-dev say/ask/listen`, which uses it when set)
posts as 【lane】 in the owner's thread only. A token never evals, pairs or
answers a card; eval stays on the grant path (`eval.ts`, `lianki-dev serve`).

## Where requests actually go (cut over 2026-10-06)

**`lianki.com` is served by the `lianki` Cloudflare Worker** — the OpenNext
build of `app/**` with `DB_BACKEND=d1`. It is attached by a Worker **route**
`lianki.com/*` on the zone; the DNS record still points at Vercel underneath,
so the route alone decides. A second route covers `www.lianki.com/*`, so that
hostname is the **Worker** too — it 308s to the apex with no `x-vercel-id`.
Two narrower routes go to small Workers first: `lianki.com/api/version/*` to
`lianki-push` (`workers/push`) and `lianki.com/api/words/tts*` to
`lianki-voice` (`workers/voice`: recorded word clips at the edge; the rest
passed on to `lianki`). A recorded clip never shows in `wrangler tail lianki`.

| signal                                        | reading                                                         |
| --------------------------------------------- | --------------------------------------------------------------- |
| no `x-vercel-id` on `https://lianki.com/`     | apex served by the **Worker**                                   |
| no `x-vercel-id` on `https://www.lianki.com/` | www served by the **Worker** as well, since 2026-10-14          |
| `x-vercel-id` on `https://fsrsnext.*`         | expected — those legacy redirects are still Vercel's            |
| `GET /api/health`                             | 404 — that route was the shelved cf-native design, not a signal |

```bash
curl -sI https://lianki.com/en | grep -i x-vercel-id   # nothing = Worker
```

So: production runtime errors are in `wrangler tail lianki`, the live data is
**D1** (`lianki`), and MongoDB is a frozen rollback copy as of the cutover —
do not write to it. The Worker deploys itself after CI passes on `main`
(`.github/workflows/deploy-worker.yml`).

**Vercel no longer builds.** `vercel.json`'s `git.deploymentEnabled.main` is
`false` as of 2026-10-15, so a push to `main` triggers nothing there. The
project is deliberately _not_ deleted and its domains are left in place:
`fsrsnext.snomiao.com` and `fsrsnext.vercel.app` still 308 to `lianki.com`
from Vercel, and that redirect target must stay in the project or both break.
`lianki.com` and `www.lianki.com` are listed there too but dark — the Worker
routes intercept both, so neither reaches Vercel (`www` answers 308 with no
`x-vercel-id`). `beta.lianki.com` already 404s.

`apps/**` (cf-native) is shelved. Rollback, the load
procedure, and the cutover scripts are in
[docs/cf-d1-migration.md](docs/cf-d1-migration.md). `dev.lianki.com` is
unrelated — a Cloudflare tunnel to the local userscript dev server.

## i18n: never translate a string without its context

UI strings are intlayer `*.content.ts` files, 16 locales. Never send a short
string (a setting name, menu item, button, logo text) to translation on its
own: each key carries a context line — where it appears, what it is for, how
it is used — and is translated together with it. New keys get their line in
the same change; translators read it before every string. How:
[docs/i18n.md](docs/i18n.md).

## Report progress to the state tree

While working on Lianki, report to the live state tree
([docs/state-tree.md](docs/state-tree.md), "Live progress") at the start, at
milestones, when blocked, and when done (with the PR):
`bun scripts/dev/progress.ts --agent <you> --path /<route>/<task> --task "<name>: <description>" --status doing --pct 40 --eta 12m-63m`
(`--eta` is one time or a P5–P95 range; `--confirm` re-confirms it unchanged;
`batch` writes several nodes as one change; `--done --pr N` at the end, or `--done --verified "<evidence>"` / `--unverified`;
`--status waiting-owner --needs "…"` when the owner must act; `--status blocked --who <owner|lane> --needs "…"` when
someone can act now; `--status waiting` when paused on an outside event). The title is "name: description" with a name
at most 20 columns wide (a Chinese character is 2), because the owner's ETA bar shows only the name (a new wider one is
refused). `progress.ts stats` shows your estimate vs actual, to calibrate `--eta`. Use the token you were given (`--token` or
`LIANKI_PROGRESS_TOKEN`); stay inside its scope.

**ETA overrun is never silent.** A task that reaches its `--eta` unfinished
tells the owner, within 5 minutes, the reason and a new "N minutes from now":
`progress.ts … --status doing --eta 20m --late "<reason, in his language>"` —
the hub posts both to him in Li. Past the ETA a new `--eta` without `--late`
is refused. The "ETA reached" line carries a receipt code: ack it at once
(`progress.ts ack <code>`, or any report on the node). No ack in 5 minutes:
main is told; no reason 5 minutes later: he hears "<name> 超时，未说明原因",
then again with backoff.
[docs/state-tree.md](docs/state-tree.md), "ETA overrun", "Receipts".

## Where to look

Read the relevant file before working in that area — each one carries decisions
that are expensive to rediscover.

| Working on                                                               | Read                                                                |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Running or setting up the app locally, QA suites                         | [DEVELOPMENT.md](DEVELOPMENT.md)                                    |
| What's in flight / waiting on the owner                                  | [docs/state-tree.md](docs/state-tree.md)                            |
| Planning tools: which one to use, consolidation plan                     | [docs/planning-tools.md](docs/planning-tools.md)                    |
| Landing changes, CI, branch protection, post-deploy QA                   | [docs/shipping.md](docs/shipping.md)                                |
| Finding your way around the code                                         | [docs/repo-map.md](docs/repo-map.md)                                |
| Adding or renaming a route: nouns, /lab, /dev, 308 redirects             | [docs/url-principles.md](docs/url-principles.md)                    |
| /my: the user's own data (profile, preferences, files)                   | [docs/url-principles.md](docs/url-principles.md), "/my"             |
| Secrets, auth, OAuth config                                              | [docs/secrets-and-auth.md](docs/secrets-and-auth.md)                |
| Transactional mail: templates, /dev/templates, locked variables          | [docs/mail-templates.md](docs/mail-templates.md)                    |
| Every sent mail: the send log at /dev/mails, statuses, Resend rules      | [docs/mail-templates.md](docs/mail-templates.md), "Send log"        |
| Permissions: `isAdmin`/`isDev`, /dev/permissions, break-glass CLI        | [docs/secrets-and-auth.md](docs/secrets-and-auth.md), "Permissions" |
| Who may do what: isAdmin/isDev grants, /dev/permissions, break-glass CLI | [docs/secrets-and-auth.md](docs/secrets-and-auth.md), "Permissions" |
| Google Drive connection (/connections), private Docs import              | [docs/connections.md](docs/connections.md)                          |
| Anything calling an LLM or TTS                                           | [docs/workers-ai.md](docs/workers-ai.md)                            |
| Learning Partner AI replies for users (DeepSeek, caps)                   | [docs/partner-ai.md](docs/partner-ai.md)                            |
| Chat history in D1, /chat/history (what is kept, never kept)             | [docs/chat-history.md](docs/chat-history.md)                        |
| Users' own AI key and backend (BYOK, browser-only, presets)              | [docs/byok.md](docs/byok.md)                                        |
| The owner's local streaming speech-to-text (mic → his Mac)               | [docs/local-stt.md](docs/local-stt.md)                              |
| /vibe: a conversation transcribed into a private doc                     | [docs/vibe.md](docs/vibe.md)                                        |
| Whole-page dev server on prod D1 (owner only, home LAN)                  | [docs/dev-whole-page.md](docs/dev-whole-page.md)                    |
| A friend's dev container (devbox: agents, local D1, tunnel)              | [devbox/README.md](devbox/README.md)                                |
| A box signing in through lianki.com (OAuth, token gate)                  | [docs/box-oauth.md](docs/box-oauth.md)                              |
| The userscript's dev loader (hot reload over a CF tunnel)                | [docs/dev-userscript-loader.md](docs/dev-userscript-loader.md)      |
| Hosting the dev loader on lianki.com (design stub)                       | [docs/loader-hosting.md](docs/loader-hosting.md)                    |
| Li chat from the userscript pill: security gate (stub)                   | [docs/userscript-li-chat.md](docs/userscript-li-chat.md)            |
| Hot-swapping headless core modules (kernel, swap, leak tests)            | [docs/hot-core.md](docs/hot-core.md)                                |
| The debug chat widget (packages/debug-chat), hot-loading                 | [docs/dev-debug-widget.md](docs/dev-debug-widget.md)                |
| Users' own AI assistants: the token prompt, /api/agent-guide             | [docs/api-for-agents.md](docs/api-for-agents.md)                    |
| `lianki-dev`, the agent lanes' CLI: say, ask, progress, doctor           | [docs/lianki-dev-cli.md](docs/lianki-dev-cli.md)                    |
| Which lane answers him ("codex, …"), codex/agy listeners                 | [docs/lane-listen.md](docs/lane-listen.md)                          |
| Hot islands: swappable components, shared state                          | [docs/dev-hot-islands.md](docs/dev-hot-islands.md)                  |
| Live view: dev JS or whole dev pages (?live=) on lianki.com              | [docs/live-view.md](docs/live-view.md)                              |
| Custom frontends: a user's own dev server at ?live, the /api contract    | [docs/custom-frontend.md](docs/custom-frontend.md)                  |
| The /words swipe: headless core, UI islands, feel presets                | [docs/swipe-core.md](docs/swipe-core.md)                            |
| UI state: what is kept where (session, local, URL, server)               | [docs/ui-state.md](docs/ui-state.md)                                |
| Screenshots of the owner's phone page (`scripts/dev/shot.ts`)            | [docs/dev-debug-widget.md](docs/dev-debug-widget.md), "Screenshots" |
| UI strings, translations: every key carries context                      | [docs/i18n.md](docs/i18n.md)                                        |
| Blog posts                                                               | [blog/AGENTS.md](blog/AGENTS.md)                                    |
| The Chrome extension, and publishing it                                  | [packages/ext/README.md](packages/ext/README.md)                    |
| /words new-word order: in order + pass, take turns, simulator            | [docs/new-word-scheduler.md](docs/new-word-scheduler.md)            |
| Exam word decks (CET, TOEFL, GRE…): sources, licences, gaps              | [docs/word-deck-sources.md](docs/word-deck-sources.md)              |
| /self-intro import: files/text → facts → review; privacy                 | [docs/self-intro-import.md](docs/self-intro-import.md)              |
| Import any material: upload → job → /words or /reader (stub)             | [docs/import-material.md](docs/import-material.md)                  |
| YouTube songs: timed lyric lines as example clips (stub)                 | [docs/youtube-song-examples.md](docs/youtube-song-examples.md)      |
| /books public-domain library: catalogue rule, slugs, R2 cache            | [docs/books-plan.md](docs/books-plan.md), "The catalogue: /books"   |
| Voice mode: spoken commands per screen, grammar, mic taps                | [docs/voice-mode.md](docs/voice-mode.md)                            |
| All sound through Li: `__lkLi` hub, who holds mic / plays                | [docs/li-sound-hub.md](docs/li-sound-hub.md)                        |
| /words owner spec: tall slips, window, review-first, voice               | [docs/words-session-spec.md](docs/words-session-spec.md)            |
| PWA cold start: measuring it, per-page dictionaries, lazy chat, SW       | [docs/cold-start.md](docs/cold-start.md)                            |
| Branch API previews: Core gateway, MyBox auth, sandbox persistence | [docs/api-preview-proxy.md](docs/api-preview-proxy.md) |
| Sync/offline architecture                                                | [docs/sync-architecture.md](docs/sync-architecture.md)              |
| Sync conflicts, deletions, tombstones                                    | [docs/sync-merge-rules.md](docs/sync-merge-rules.md)                |
| Settings that follow the account (`lk:*` key classes)                    | [docs/prefs-sync.md](docs/prefs-sync.md)                            |
| Notification prefixes in page titles: rules, safe matcher                | [docs/title-clean.md](docs/title-clean.md)                          |
| App-icon badge (PWA): what it counts, /api/badge, the SW push            | [docs/app-badge.md](docs/app-badge.md)                              |
| Links to other sites: the disclaimer dialog, its bypasses                | [docs/external-links.md](docs/external-links.md)                    |
| Metrics, slowness and error alerts (Slack #lianki)                       | [docs/monitoring.md](docs/monitoring.md)                            |
| Payments, Pro passes, Stripe, invites, gift codes                        | [docs/payments.md](docs/payments.md)                                |
| Study ledger: daily Merkle anchors, proofs, OpenTimestamps               | [docs/lian.md](docs/lian.md)                                        |
| Learner levels: ladder, names per locale, SVG badges                     | [docs/levels.md](docs/levels.md)                                    |
| Feature flags: owner on/off at /dev/flags, ship dark, remove             | [docs/feature-flags.md](docs/feature-flags.md)                      |
| Live config values (numbers, texts): registry, `cfg()`, /dev/config      | [docs/config-store.md](docs/config-store.md)                        |
| Security measures: admin gate, lockout, scans, card testing              | [docs/security-measures.md](docs/security-measures.md)              |
| UI layout: content fills the screen, glass overlays                      | [docs/design-principles.md](docs/design-principles.md)              |
| rgui component library (subtree), its gantt module, upstream sync        | [docs/rgui.md](docs/rgui.md)                                        |
| Leaving Next.js: Vite + RR7 + Hono strangler plan                        | [docs/framework-migration.md](docs/framework-migration.md)          |
| Node tree, study plan, calendar, Google Calendar (design)                | [docs/calendar-plan.md](docs/calendar-plan.md)                      |
| /roadmap: progress from cards, what to build next                        | [docs/roadmap-next.md](docs/roadmap-next.md)                        |

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
