# Lianki — Claude Project Notes

## Project

Spaced repetition app (FSRS algorithm) built with Next.js 15. Renamed from FSRSNext → Lianki.

- Repo: https://github.com/snomiao/lianki
- Production: https://www.lianki.com (Vercel, `main` branch)
- Beta: https://beta.lianki.com (Vercel, `beta` branch, preview deployment)
- Old domain `fsrsnext.snomiao.com` → 308 redirects to `www.lianki.com`

## Stack

- **Framework**: Next.js 16 App Router (Turbopack), TypeScript
- **Package manager**: Bun
- **Database**: MongoDB (env: `MONGODB_URI`)
- **Auth**: NextAuth.js v5 — Email, GitHub, Google OAuth
- **UI**: Tailwind CSS (via `app/globals.css`)
- **Linting**: oxlint (`--ignore-pattern 'packages/**'`)
- **Formatting**: oxfmt (ignores `packages/` via `.prettierignore`)
- **Pre-commit**: Husky → `bun fix` (oxlint + oxfmt) + `bunx @typescript/native-preview --noEmit`

## Routing

- `/` — landing page (`app/page.tsx`)
- `/list` — note-listing app page (`app/list/page.tsx`)
- `/api/fsrs/*` — FSRS API endpoints
- `/api/auth/*` — NextAuth routes

## Deployment (Vercel)

- Project ID: `prj_BoWb5ZrwLrYVyAxGb8a5XOs7i7gu`
- Org ID: `team_0YVgkyqvak5X8lMl3zNBqIC7`
- DNS: Cloudflare nameservers (`lia.ns.cloudflare.com`, `roan.ns.cloudflare.com`)
- CI: `.github/workflows/deploy.yml` — `main` deploys `--prod`, `beta` deploys as preview
- Required GitHub secrets: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`

## Packages / Submodules

- `packages/pardon-could-you-say-it-again` — git submodule from https://github.com/snomiao/pardon-could-you-say-it-again
- Workspaces: `packages/*` (bun workspaces)
- `packages/` is excluded from oxlint and oxfmt to avoid dirtying submodule content

## Key Files

| File                           | Purpose                               |
| ------------------------------ | ------------------------------------- |
| `app/page.tsx`                 | Landing page                          |
| `app/list/page.tsx`            | Note listing (main app)               |
| `app/fsrs.ts`                  | Core FSRS handler logic               |
| `app/db.ts`                    | MongoDB client                        |
| `auth.ts` / `auth.config.ts`   | NextAuth setup                        |
| `public/lianki.user.js`        | Tampermonkey/Violentmonkey userscript |
| `.husky/pre-commit`            | Pre-commit hook                       |
| `.github/workflows/deploy.yml` | CI/CD to Vercel                       |

## Google OAuth

Credentials (`AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`) are shared between `fsrsnext.snomiao.com` and `lianki.com`. Both domains need to be in the Google Cloud Console OAuth client's authorized origins and redirect URIs:

- `https://lianki.com/api/auth/callback/google`
- `https://www.lianki.com/api/auth/callback/google`

## Workflow Reminders

### After Every Push

**ALWAYS check CI/deployment status immediately after pushing:**

```bash
# Check GitHub Actions CI status
gh run list --branch main --limit 5

# Check Vercel deployment status
vercel ls | head -20

# Inspect failed deployment
vercel inspect <deployment-url>

# Check what's live in production
curl -s https://www.lianki.com/lianki.user.js | grep '@version'
```

**Common failure modes:**

- Vercel build fails (check logs with `vercel logs <url>`)
- Edge runtime incompatibility (e.g., Node.js `crypto` module not available)
- TypeScript errors (enable type checking in build)
- Missing environment variables

**If deployment fails:**

1. Check build logs via Vercel dashboard or CLI
2. Fix the issue locally
3. Test build with `bun run build`
4. Push fix and verify deployment succeeds
