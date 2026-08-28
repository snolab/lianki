# Repo map

## Stack

- **Framework**: Next.js 16 App Router (Turbopack), TypeScript
- **Package manager**: Bun
- **Database**: MongoDB (env: `MONGODB_URI`); the deployed Worker path runs
  Cloudflare D1 (`DB_BACKEND=d1`)
- **Auth**: NextAuth.js v5 — Email, GitHub, Google OAuth
- **UI**: Tailwind CSS (via `app/globals.css`)
- **FSRS**: `ts-fsrs`
- **Linting/Formatting**: oxlint + oxfmt (both ignore `packages/`)

## Key files

| File | Purpose |
| ---- | ------- |
| `app/page.tsx` | Landing page |
| `app/(app)/list/page.tsx` | Note listing (main app) |
| `lib/app-locale.ts` | `?lang=` locale helpers + APP_ROUTES |
| `app/fsrs.ts` | Core FSRS handler logic |
| `app/db.ts` | MongoDB client |
| `auth.ts` / `auth.config.ts` | NextAuth setup |
| `src/lianki.user.ts` | Userscript source |
| `public/lianki.user.js` | Built userscript (`lianki.meta.js` is auto-synced from its header) |
| `public/loader.user.js` | Published dev loader — re-fetches from vite `:3002` per page load |
| `scripts/dev-userscript-server.ts` | Dev loader server — pushes builds over a CF tunnel |
| `scripts/dev-loader.user.js` | Loader template that server renders |
| `scripts/pre-commit.ts` | Pre-commit hook (run via Husky) |
| `scripts/ship.ts` | Land a commit on `main` |
| `.github/workflows/ci.yml` | Typecheck + unit, qa:all |
| `.github/workflows/deploy.yml` | CI/CD to Vercel |

## Userscript

Source is `src/lianki.user.ts`. `public/lianki.user.js` is the build; the
pre-commit hook syncs `lianki.meta.js` from its header and refuses a change
without a `@version` bump.

For the install-once dev loader — save, and every attached browser (including a
phone, over a Cloudflare tunnel) runs the new build — see
[dev-userscript-loader.md](dev-userscript-loader.md):

```bash
bun run dev:loader                              # quick tunnel, bundle talks to lianki.com
bun run dev:loader --app http://localhost:3000  # ...talks to the local Next dev server
bun run dev:loader --tunnel lianki-userscript-dev --origin https://dev.lianki.com --port 5173
```

The last one is the permanent install at `dev.lianki.com` — the hostname
survives restarts, so the loader is installed once and never again.
