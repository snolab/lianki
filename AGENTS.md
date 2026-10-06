# AGENTS.md — Lianki

Spaced repetition app (FSRS algorithm) on Next.js 16 + Bun. Production:
https://lianki.com (Vercel, deploys from `main`). Repo: `snolab/lianki`.

`CLAUDE.md` imports this file — edit this one.

## Hard rules

- **NEVER `git push --force`.** If histories diverge, ask how to proceed.
- **NEVER `--no-verify`** — the pre-commit hook syncs `lianki.meta.js`, scans
  secrets, lints, builds, and tests. Bypassing causes meta drift and broken
  userscript auto-updates.
- **NEVER `git reset --hard`** to move a branch — it silently destroys
  uncommitted work. Use `git reset --keep`, which aborts instead of overwriting.
- Always bump `@version` in `lianki.user.js` when changing the userscript.
- `.env.local` and `.dev.vars` are gitignored and unrecoverable — never delete
  them.
- Use owner `snolab` for every `gh` / `gh api` call. A wrong owner returns a
  plan-gated 403 that misleadingly reads as "branch protection is off".

## Commands

```bash
bun run dev            # Next.js :3000   (bun run dev:db first for local Mongo)
bun run typecheck      # tsgo --noEmit
bun test               # unit tests
bun fix                # oxlint --fix + oxfmt
bun run qa:all         # full integration gate — what CI runs, and pre-push
bun scripts/ship.ts    # land the current commit on main via PR + auto-merge
```

## Where requests actually go (cut over 2026-10-06)

**`lianki.com` is served by the `lianki` Cloudflare Worker** — the OpenNext
build of `app/**` with `DB_BACKEND=d1`. It is attached by a Worker **route**
`lianki.com/*` on the zone; the DNS record still points at Vercel underneath,
so the route alone decides. `www.lianki.com` is still Vercel, which only 301s
to the apex.

| signal | reading |
| --- | --- |
| no `x-vercel-id` on `https://lianki.com/` | apex served by the **Worker** |
| `x-vercel-id` on `https://www.lianki.com/` | expected — Vercel's www→apex redirect |
| `GET /api/health` | 404 — that route was the shelved cf-native design, not a signal |

```bash
curl -sI https://lianki.com/en | grep -i x-vercel-id   # nothing = Worker
```

So: production runtime errors are in `wrangler tail lianki`, the live data is
**D1** (`lianki`), and MongoDB is a frozen rollback copy as of the cutover —
do not write to it. The Worker deploys itself after CI passes on `main`
(`.github/workflows/deploy-worker.yml`); Vercel still builds but serves only
the www redirect. `apps/**` (cf-native) is shelved. Rollback, the load
procedure, and the cutover scripts are in
[docs/cf-d1-migration.md](docs/cf-d1-migration.md). `dev.lianki.com` is
unrelated — a Cloudflare tunnel to the local userscript dev server.

## Where to look

Read the relevant file before working in that area — each one carries decisions
that are expensive to rediscover.

| Working on | Read |
| ---------- | ---- |
| Running or setting up the app locally, QA suites | [DEVELOPMENT.md](DEVELOPMENT.md) |
| Landing changes, CI, branch protection, post-deploy QA | [docs/shipping.md](docs/shipping.md) |
| Finding your way around the code | [docs/repo-map.md](docs/repo-map.md) |
| Secrets, auth, OAuth config | [docs/secrets-and-auth.md](docs/secrets-and-auth.md) |
| Anything calling an LLM or TTS | [docs/workers-ai.md](docs/workers-ai.md) |
| The userscript's dev loader (hot reload over a CF tunnel) | [docs/dev-userscript-loader.md](docs/dev-userscript-loader.md) |
| Blog posts | [blog/AGENTS.md](blog/AGENTS.md) |
| Sync/offline architecture | [docs/sync-architecture.md](docs/sync-architecture.md) |
| Sync conflicts, deletions, tombstones | [docs/sync-merge-rules.md](docs/sync-merge-rules.md) |
