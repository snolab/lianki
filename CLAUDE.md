# Lianki — Claude Project Notes

## Rules

- **NEVER use `git push --force`** under any circumstances. Always use regular `git push`. If histories diverge, ask the user how to proceed.

## Project

Spaced repetition app (FSRS algorithm) built with Next.js 16. Renamed from FSRSNext → Lianki.

- Repo: https://github.com/snolab/lianki — this is `origin`, and what deploys. Use this owner for
  every `gh` / `gh api` call; a wrong owner returns a plan-gated 403 that misleadingly reads as
  "branch protection is off".
- Production: https://lianki.com (Vercel, `main` branch)

## Stack

- **Framework**: Next.js 16 App Router (Turbopack), TypeScript
- **Package manager**: Bun
- **Database**: MongoDB (env: `MONGODB_URI`)
- **Auth**: NextAuth.js v5 — Email, GitHub, Google OAuth
- **UI**: Tailwind CSS (via `app/globals.css`)
- **Linting/Formatting**: oxlint + oxfmt (both ignore `packages/`)
- **Pre-commit**: `scripts/pre-commit.ts` — secretlint, bun fix, typecheck, build, vitest, userscript sync
- **Secret scanning**: gitleaks (CI, full history) — `bun run scan:secrets` locally; config in `.gitleaks.toml`

## Key Files

| File                           | Purpose                               |
| ------------------------------ | ------------------------------------- |
| `app/page.tsx`                 | Landing page                          |
| `app/(app)/list/page.tsx`      | Note listing (main app)               |
| `lib/app-locale.ts`            | `?lang=` locale helpers + APP_ROUTES  |
| `app/fsrs.ts`                  | Core FSRS handler logic               |
| `app/db.ts`                    | MongoDB client                        |
| `auth.ts` / `auth.config.ts`   | NextAuth setup                        |
| `public/lianki.user.js`        | Tampermonkey/Violentmonkey userscript |
| `scripts/pre-commit.ts`        | Pre-commit hook (run via Husky)       |
| `.github/workflows/deploy.yml` | CI/CD to Vercel                       |

## Google OAuth

Credentials (`AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`) are shared between `fsrsnext.snomiao.com` and `lianki.com`. Both domains must be in the Google Cloud Console OAuth client:

- `https://lianki.com/api/auth/callback/google` (canonical)
- `https://www.lianki.com/api/auth/callback/google` (keep registered — www still resolves and 308s to apex)

## Hard Rules

- **NEVER use `--no-verify`** — the pre-commit hook syncs `lianki.meta.js`, scans secrets, lints, builds, and runs tests. Bypassing causes meta drift and broken userscript auto-updates.
- Always bump `@version` in `lianki.user.js` when changing the userscript.

## Shipping to main

Commit on `main`, then:

```bash
bun scripts/ship.ts
```

It pushes HEAD to a `ship/<sha>` branch, opens a PR, arms auto-merge (squash), waits for the required checks, then syncs local `main` and deletes the branch. `main` is the only long-lived branch.

`main` cannot be pushed to directly: `enforce_admins` is on, so a direct `git push origin main` is rejected with `GH006 … 2 of 2 required status checks are expected` unless the pushed SHA already has green checks. The PR is what gets the checks run.

## CI & Auto-Merge

- **CI** (`.github/workflows/ci.yml`, on PRs/pushes to `main`): two jobs — `Typecheck + unit` and `qa:all (D1/Workers)` (`bun run qa:all`). Node 24 (for `node:sqlite`); wrangler runs D1 locally so no Cloudflare secrets are needed.
- **`main` protection is two mechanisms** — don't confuse them when debugging a rejected push:
  - *Classic branch protection* holds the required checks (`Typecheck + unit`, `qa:all (D1/Workers)`), `strict: false`, `enforce_admins: true`, and **no** required PR reviews. Read it with `gh api repos/snolab/lianki/branches/main/protection`.
  - *Ruleset `cipass`* (id 13053938) blocks deletion, force-push, and non-linear history. Read it with `gh api repos/snolab/lianki/rulesets/13053938`.
  - Emergency override: `gh api --method DELETE repos/snolab/lianki/branches/main/protection/enforce_admins`.
- **Auto-merge**: `gh pr merge <N> --auto --squash` waits for both required checks, then merges. The repo's "Allow auto-merge" setting must be ON (it is).
  - **Gotcha**: if that setting is OFF, `--auto` returns exit 0 but silently does nothing. Confirm it armed with `gh pr view <N> --json autoMergeRequest` (should be non-null). With no required checks, `--auto` merges *immediately* — which is why protection must stay in place.

## Local git hazards

- **Never `git reset --hard`** to move a branch — it silently destroys uncommitted work in the tree. Use `git reset --keep`, which moves HEAD but aborts rather than overwrite local modifications. `scripts/ship.ts` uses `--keep` for exactly this reason.

## QA Process — after every deploy

Use remote Chrome AND Vercel logs together:

```bash
# 1. Navigate in remote Chrome, note any digest shown
# 2. Stream logs to find the real error behind the digest:
vercel logs https://lianki.com 2>&1 | head -80
```

Production Next.js hides error messages — the UI shows a digest, the real error is in Vercel runtime logs. Match digest to confirm root cause. A repeated digest after redeploy means the same error persists.
