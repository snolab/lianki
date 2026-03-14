# Lianki — Claude Project Notes

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

# After PR merges, always rebase beta:
git fetch origin && git rebase origin/main
git push -f origin beta
```

## QA Process — after every deploy

Use remote Chrome AND Vercel logs together:

```bash
# 1. Navigate in remote Chrome, note any digest shown
# 2. Stream logs to find the real error behind the digest:
vercel logs https://www.lianki.com 2>&1 | head -80
```

Production Next.js hides error messages — the UI shows a digest, the real error is in Vercel runtime logs. Match digest to confirm root cause. A repeated digest after redeploy means the same error persists.
