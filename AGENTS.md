# AGENTS.md — Lianki

Spaced repetition app (FSRS algorithm) on Next.js 16 + Bun. Production:
https://lianki.com (Vercel, deploys from `main`). Repo: `snolab/lianki`.

`CLAUDE.md` imports this file — edit this one.

## Hard rules

- **NEVER `git push --force`.** If histories diverge, ask how to proceed.
- **NEVER `--no-verify`** — pre-commit (seconds, staged files only) scans
  secrets, runs oxlint --fix + oxfmt, and syncs the userscript build,
  `lianki.meta.js` and `@version`; pre-push runs whole-repo lint, typecheck,
  the unit suite with its coverage gate, then `qa:all`. Bypassing causes meta
  drift, broken userscript auto-updates, and failures CI finds later.
- **NEVER `git reset --hard`** to move a branch — it silently destroys
  uncommitted work. Use `git reset --keep`, which aborts instead of overwriting.
- Always bump `@version` in `lianki.user.js` when changing the userscript.
- `.env.local` and `.dev.vars` are gitignored and have no other copy — never
  delete them. An encrypted backup is proposed in
  [docs/secrets-backup-plan.md](docs/secrets-backup-plan.md) (not done yet).
- Use owner `snolab` for every `gh` / `gh api` call. A wrong owner returns a
  plan-gated 403 that misleadingly reads as "branch protection is off".

## Commands

```bash
bun run dev            # Next.js :3000   (bun run dev:db first for local Mongo)
bun run typecheck      # tsgo --noEmit
bun test               # unit tests
bun fix                # oxlint --fix + oxfmt
bun run lint           # oxlint + oxfmt --check, whole repo (pre-push and CI run it)
bun run qa:all         # full integration gate — pre-push, and CI nightly (not per push)
bun scripts/ship.ts    # land the current commit on main via PR + auto-merge
```

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
`bun scripts/dev/progress.ts --agent <you> --path /<route>/<task> --task "<what>" --status doing --pct 40`
(`--done --pr N` at the end; `--status waiting-owner --needs "…"` when the
owner must act). Use the token you were given (`--token` or
`LIANKI_PROGRESS_TOKEN`); stay inside its scope.

## Where to look

Read the relevant file before working in that area — each one carries decisions
that are expensive to rediscover.

| Working on                                                    | Read                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------- |
| Running or setting up the app locally, QA suites              | [DEVELOPMENT.md](DEVELOPMENT.md)                                    |
| What's in flight / waiting on the owner                       | [docs/state-tree.md](docs/state-tree.md)                            |
| Landing changes, CI, branch protection, post-deploy QA        | [docs/shipping.md](docs/shipping.md)                                |
| Finding your way around the code                              | [docs/repo-map.md](docs/repo-map.md)                                |
| Secrets, auth, OAuth config                                   | [docs/secrets-and-auth.md](docs/secrets-and-auth.md)                |
| Google Drive connection (/connections), private Docs import   | [docs/connections.md](docs/connections.md)                          |
| Anything calling an LLM or TTS                                | [docs/workers-ai.md](docs/workers-ai.md)                            |
| Learning Partner AI replies for users (DeepSeek, caps)        | [docs/partner-ai.md](docs/partner-ai.md)                            |
| The owner's local streaming speech-to-text (mic → his Mac)    | [docs/local-stt.md](docs/local-stt.md)                              |
| Whole-page dev server on prod D1 (owner only, home LAN)       | [docs/dev-whole-page.md](docs/dev-whole-page.md)                    |
| The userscript's dev loader (hot reload over a CF tunnel)     | [docs/dev-userscript-loader.md](docs/dev-userscript-loader.md)      |
| Hot-swapping headless core modules (kernel, swap, leak tests) | [docs/hot-core.md](docs/hot-core.md)                                |
| The debug chat widget (packages/debug-chat), hot-loading      | [docs/dev-debug-widget.md](docs/dev-debug-widget.md)                |
| Hot islands: swappable components, shared state               | [docs/dev-hot-islands.md](docs/dev-hot-islands.md)                  |
| Live view: dev JS or whole dev pages (?live=) on lianki.com   | [docs/live-view.md](docs/live-view.md)                              |
| Custom frontends: a user's own dev server at ?live, the /api contract | [docs/custom-frontend.md](docs/custom-frontend.md)          |
| The /words swipe: headless core, UI islands, feel presets     | [docs/swipe-core.md](docs/swipe-core.md)                            |
| UI state: what is kept where (session, local, URL, server)    | [docs/ui-state.md](docs/ui-state.md)                                |
| Screenshots of the owner's phone page (`scripts/dev/shot.ts`) | [docs/dev-debug-widget.md](docs/dev-debug-widget.md), "Screenshots" |
| UI strings, translations: every key carries context           | [docs/i18n.md](docs/i18n.md)                                        |
| Blog posts                                                    | [blog/AGENTS.md](blog/AGENTS.md)                                    |
| The Chrome extension, and publishing it                       | [packages/ext/README.md](packages/ext/README.md)                    |
| /words new-word order: in order + pass, take turns, simulator | [docs/new-word-scheduler.md](docs/new-word-scheduler.md)            |
| Exam word decks (CET, TOEFL, GRE…): sources, licences, gaps   | [docs/word-deck-sources.md](docs/word-deck-sources.md)              |
| /self-intro import: files/text → facts → review; privacy        | [docs/self-intro-import.md](docs/self-intro-import.md)              |
| /books public-domain library: catalogue rule, slugs, R2 cache | [docs/books-plan.md](docs/books-plan.md), "The catalogue: /books"   |
| Voice mode: spoken commands per screen, grammar, mic taps     | [docs/voice-mode.md](docs/voice-mode.md)                            |
| /words owner spec: tall slips, window, review-first, voice    | [docs/words-session-spec.md](docs/words-session-spec.md)            |
| Sync/offline architecture                                     | [docs/sync-architecture.md](docs/sync-architecture.md)              |
| Sync conflicts, deletions, tombstones                         | [docs/sync-merge-rules.md](docs/sync-merge-rules.md)                |
| Settings that follow the account (`lk:*` key classes)         | [docs/prefs-sync.md](docs/prefs-sync.md)                            |
| Metrics, slowness and error alerts (Slack #lianki)            | [docs/monitoring.md](docs/monitoring.md)                            |
| Payments, Pro passes, Stripe, invites, gift codes             | [docs/payments.md](docs/payments.md)                                |
| Learner levels: ladder, names per locale, SVG badges          | [docs/levels.md](docs/levels.md)                                    |
| Feature flags: owner on/off at /dev/flags, ship dark, remove  | [docs/feature-flags.md](docs/feature-flags.md)                      |
| Security measures: admin gate, lockout, scans, card testing   | [docs/security-measures.md](docs/security-measures.md)              |
| UI layout: content fills the screen, glass overlays           | [docs/design-principles.md](docs/design-principles.md)              |
| Leaving Next.js: Vite + RR7 + Hono strangler plan             | [docs/framework-migration.md](docs/framework-migration.md)          |
| Node tree, study plan, calendar, Google Calendar (design)     | [docs/calendar-plan.md](docs/calendar-plan.md)                      |

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
