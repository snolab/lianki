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

## Where requests actually go (verified 2026-08-03)

**The CF-native cutover has NOT happened.** Cloudflare fronts the DNS, which
makes responses *look* Cloudflare-served and has caused this to be misremembered
as migrated. It is not:

| signal | reading |
| --- | --- |
| `x-vercel-id` on every response | www / apex are served by **Vercel** |
| `server: cloudflare`, `cf-ray` | Cloudflare **DNS proxy** only — the orange cloud, not the Worker |
| `GET /api/health` (Worker-only route) | **404** on every lianki.com hostname |

Re-check with:

```bash
curl -sI https://www.lianki.com/ | grep -iE 'x-vercel-id|cf-ray'
curl -sL -o /dev/null -w '%{http_code}\n' https://lianki.com/api/health   # 404 = still Vercel
```

While this holds: production runtime errors are in **Vercel** logs, the live
code is `app/**` + MongoDB, and a fix in `apps/api/src/worker/**` or the D1
migrations changes nothing in prod. `dev.lianki.com` is unrelated — a Cloudflare
tunnel to the local userscript dev server, not the Worker.

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
