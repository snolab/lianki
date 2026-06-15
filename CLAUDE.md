# Lianki — Claude Project Notes

## Rules

- **NEVER use `git push --force`** under any circumstances. Always use regular `git push`. If histories diverge, ask the user how to proceed.

## Project

Spaced repetition app (FSRS algorithm) built with Next.js 16. Renamed from FSRSNext → Lianki.

- Repo: https://github.com/snomiao/lianki
- Production: https://www.lianki.com (Vercel, `main` branch)
- Beta: https://beta.lianki.com (Vercel, `beta` branch)

## Stack

- **Framework**: Next.js 16 App Router (Turbopack), TypeScript
- **Package manager**: Bun
- **Database**: MongoDB (env: `MONGODB_URI`)
- **Auth**: NextAuth.js v5 — Email, GitHub, Google OAuth
- **UI**: Tailwind CSS (via `app/globals.css`)
- **Linting/Formatting**: oxlint + oxfmt (both ignore `packages/`)
- **Pre-commit**: `scripts/pre-commit.ts` — secretlint, bun fix, typecheck, build, vitest, userscript sync

## Key Files

| File                           | Purpose                               |
| ------------------------------ | ------------------------------------- |
| `app/page.tsx`                 | Landing page                          |
| `app/[locale]/list/page.tsx`   | Note listing (main app)               |
| `app/fsrs.ts`                  | Core FSRS handler logic               |
| `app/db.ts`                    | MongoDB client                        |
| `auth.ts` / `auth.config.ts`   | NextAuth setup                        |
| `public/lianki.user.js`        | Tampermonkey/Violentmonkey userscript |
| `scripts/pre-commit.ts`        | Pre-commit hook (run via Husky)       |
| `.github/workflows/deploy.yml` | CI/CD to Vercel                       |

## Google OAuth

Credentials (`AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`) are shared between `fsrsnext.snomiao.com` and `lianki.com`. Both domains must be in the Google Cloud Console OAuth client:

- `https://lianki.com/api/auth/callback/google`
- `https://www.lianki.com/api/auth/callback/google`

## Hard Rules

- **NEVER use `--no-verify`** — the pre-commit hook syncs `lianki.meta.js`, scans secrets, lints, builds, and runs tests. Bypassing causes meta drift and broken userscript auto-updates.
- Always bump `@version` in `lianki.user.js` when changing the userscript.

## PR Workflow (beta → main)

```bash
gh pr create --title "feat: description" --body "..." --base main
gh pr merge <PR_NUMBER> --auto --squash

# After PR merges, fast-forward beta to main. beta carries no commits of its
# own, so rebasing onto main is always a fast-forward and a regular push works
# (no -f — see the NEVER-force-push rule above). If the push is ever rejected as
# non-fast-forward, beta has diverged: stop and ask, don't force.
git fetch origin && git rebase origin/main
git push origin beta
```

## CI & Auto-Merge

- **CI** (`.github/workflows/ci.yml`, on PRs/pushes to `main`/`beta`): two jobs — `Typecheck + unit` and `qa:all (D1/Workers)` (`bun run qa:all`). Node 22 (for `node:sqlite`); wrangler runs D1 locally so no Cloudflare secrets are needed.
- **`main` is branch-protected**: both checks are required and `enforce_admins` is on (admins are gated too), so nothing merges to `main` until CI is green. Emergency override: `gh api --method DELETE repos/snolab/lianki/branches/main/protection/enforce_admins`.
- **Auto-merge**: `gh pr merge <N> --auto --squash` waits for both required checks, then merges. The repo's "Allow auto-merge" setting must be ON (it is).
  - **Gotcha**: if that setting is OFF, `--auto` returns exit 0 but silently does nothing. Confirm it armed with `gh pr view <N> --json autoMergeRequest` (should be non-null). With no required checks, `--auto` merges *immediately* — which is why protection must stay in place.

## QA Process — after every deploy

Use remote Chrome AND Vercel logs together:

```bash
# 1. Navigate in remote Chrome, note any digest shown
# 2. Stream logs to find the real error behind the digest:
vercel logs https://www.lianki.com 2>&1 | head -80
```

Production Next.js hides error messages — the UI shows a digest, the real error is in Vercel runtime logs. Match digest to confirm root cause. A repeated digest after redeploy means the same error persists.
