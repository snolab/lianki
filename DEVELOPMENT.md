# Lianki - Development Guide

This guide is for developers who want to run, modify, or contribute to Lianki.

## Quick start — full local app + QA (no external services)

```bash
bun install
cp .env.local.example .env.local      # defaults work out of the box
bun run dev:db                        # terminal 1 — local MongoDB replica set (:27018)
bun run dev                           # terminal 2 — Next.js (:3000)
```

Open http://localhost:3000 → **Sign in** → enter any email + password →
**Continue** → **Sign in**. In dev, email+password auth is enabled and
auto-creates the account on first sign-in, so you land on the dashboard with no
OAuth, SMTP, or Cloudflare/Turnstile setup. See `.env.local.example` for knobs.

**Why it works with nothing external:**

- **Auth** — production is passwordless (magic link + GitHub/Google). `auth.ts`
  enables email+password **only** when `NODE_ENV !== production` **and**
  `DEV_EMAIL_PASSWORD_AUTH=1`, so it can never be on in the deployed app.
- **Database** — `bun run dev:db` runs a single-node **replica set** via
  `mongodb-memory-server` (a replica set is required: better-auth uses
  transactions). It matches the example `MONGODB_URI` (`...?replicaSet=rs0`).
- **Turnstile** — only the magic-link button uses it; the dev password path
  does not, so no CAPTCHA is needed.

### QA the full user flow locally

With both servers running:

```bash
bun run qa:api    # authed API flow: signup, add/review(×4)/due/next-url,
                  # HLC 409 conflict, roadmap save + progress, prefs, export,
                  # speed-markers, token, delete, auth guard. 30 checks.
bun run qa:ui     # browser flow: sign-in form → password → dashboard → roadmap.
```

Both target `http://localhost:3000` (override with `QA_BASE`) and use throwaway
`qa+<timestamp>@lianki.test` accounts. The API script sends an `Origin` header
(better-auth rejects writes without a trusted origin — browsers send it
automatically).

### QA the **deployed D1/Workers path** — `bun run qa:all`

`bun run dev` runs the MongoDB backend. The deployed Worker runs `DB_BACKEND=d1`
(better-auth **and** app data both on Cloudflare D1). To test that real path
locally — no MongoDB, no cloud — one command does everything:

```bash
bun run qa:all                 # build + migrate + serve + 4 suites
bun run qa:all -- --no-build   # reuse the last .open-next build (fast iterate)
bun run qa:all -- --keep       # leave `wrangler dev` up after the suites
```

It (1) builds the OpenNext Worker (`CF_BUILD=1 DB_BACKEND=d1`), (2) applies
`db/migrations/*.sql` to the **local** Miniflare D1 (`wrangler d1 migrations
apply lianki --local`), (3) boots `wrangler dev` on `:3000` (matching
`auth.ts` `trustedOrigins`), then runs all four layers against the live Worker —
**API** (`qa-api`), **UI** (`qa-ui`), **sync** (`db-sync-matrix`), **userscript**
(`userscript-guest`) — and tears the server down. Non-zero exit on any failure.

Local Worker secrets come from `.dev.vars` (gitignored; auto-created from
`.dev.vars.example` on first run). It sets `NODE_ENV=development` so the dev
email+password gate is on — the deployed Worker never sees this file, so
production stays passwordless.

Prereqs: `bun install`, Playwright chromium (`bunx playwright install chromium`),
and **Node ≥ 22.12** (older Node mishandles `node:sqlite` null rows).

## Tech Stack

- **Framework**: Next.js 16 with App Router (Turbopack)
- **Language**: TypeScript
- **Database**: MongoDB with NextAuth adapter
- **Authentication**: NextAuth.js v5 (Email, GitHub, Google)
- **UI**: Tailwind CSS
- **FSRS Algorithm**: ts-fsrs
- **Runtime**: Bun (package manager)
- **Linting**: oxlint
- **Formatting**: oxfmt

## Prerequisites

- Node.js 20+ or Bun
- MongoDB instance (local or cloud)
- (Optional) SMTP server for email authentication
- (Optional) GitHub/Google OAuth credentials
- (Optional) OpenAI API key for blog auto-translation

## Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/snomiao/lianki
cd lianki
```

### 2. Install dependencies

```bash
bun install
# or
npm install
```

### 3. Set up environment variables

Copy the example environment file and configure it:

```bash
cp .env.example .env
```

Edit `.env` and fill in your values:

```env
# Required
MONGODB_URI=mongodb://localhost:27017/lianki
AUTH_SECRET=<generate with: openssl rand -base64 32>

# Optional - Email Authentication
EMAIL_SERVER=smtp://user:password@smtp.example.com:587
EMAIL_FROM=noreply@yourdomain.com

# Optional - OAuth Providers
AUTH_GITHUB_ID=your-github-client-id
AUTH_GITHUB_SECRET=your-github-client-secret
AUTH_GOOGLE_ID=your-google-client-id
AUTH_GOOGLE_SECRET=your-google-client-secret

# Optional - Blog Auto-Translation (AI-powered)
OPENAI_API_KEY=your-openai-api-key
GITHUB_INTL_TOKEN=your-github-token-for-auto-commits
```

### 4. Run the development server

```bash
bun dev
# or
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Development Commands

### Code Quality

```bash
# Run linting and formatting
bun fix

# Run linting only
bun lint

# Run type checking
bun type-check

# Build for production
bun build
```

### Git Hooks

The project uses Husky, split by speed:

**`pre-commit`** (fast, every commit):

- `oxlint --fix` + `oxfmt` (via lint-staged) and secretlint
- TypeScript type checking
- Unit tests with coverage (`bun run test:unit -- --coverage`)
- Auto-syncs `lianki.meta.js` + validates the userscript `@version` bump

**`pre-push`** (full integration, before sharing):

- `bun run qa:all` — builds the OpenNext Worker and runs the API/UI/sync/
  userscript suites against `wrangler dev` on local D1 (see the qa:all section
  above). CI runs the same command, so a `--no-verify` skip only defers failure.

Never use `--no-verify` (CLAUDE.md hard rule) — it skips the userscript meta
sync and secret scan.

## Project Structure

```
├── app/
│   ├── page.tsx              # Landing page
│   ├── list/                 # Note listing app
│   ├── fsrs.ts               # Core FSRS handler logic
│   ├── db.ts                 # MongoDB client setup
│   ├── api/
│   │   ├── fsrs/             # FSRS API endpoints
│   │   ├── auth/             # NextAuth routes
│   │   ├── translate/        # Blog translation API
│   │   └── ...
│   ├── [locale]/blog/        # Multilingual blog
│   └── [routes]/             # Other page routes
├── blog/
│   ├── en/                   # English blog posts
│   ├── zh/                   # Chinese blog posts (zh/cn)
│   └── CLAUDE.md             # Blog guidelines
├── auth.ts                   # NextAuth configuration
├── auth.config.ts            # Auth providers config
├── public/
│   ├── lianki.user.js        # Tampermonkey userscript
│   └── lianki.meta.js        # Auto-synced metadata file
├── packages/
│   └── pardon-could-you-say-it-again/  # Git submodule
├── .husky/
│   └── pre-commit            # Pre-commit hook
└── .env.example              # Environment variables template
```

## API Routes

### FSRS Routes (`/api/fsrs/*`)

- `GET /api/fsrs/next` - Redirect to next due card
- `GET /api/fsrs/next-url` - Get next due card URL (JSON)
- `GET /api/fsrs/all` - Open all due cards
- `GET /api/fsrs/add-card?url=<url>&title=<title>` - Add new card
- `GET /api/fsrs/options?id=<id>` - Get review options for card
- `GET /api/fsrs/review/:rating?id=<id>` - Submit review (returns nextUrl)
- `GET /api/fsrs/delete?id=<id>` - Delete card (returns nextUrl)
- `PATCH /api/fsrs/update-url` - Update card URL

### Other Routes

- `/api/auth/*` - NextAuth authentication routes
- `/api/translate` - Blog post translation (OpenAI GPT-4o)
- `/next` - Redirects to `/api/fsrs/next`

## Deployment

### Vercel (Recommended)

The project is configured for Vercel deployment:

1. Push your code to GitHub
2. Import the project in Vercel
3. Add environment variables in Vercel dashboard:
   - `MONGODB_URI`
   - `AUTH_SECRET`
   - `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET`
   - `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`
   - `EMAIL_SERVER` / `EMAIL_FROM`
   - `OPENAI_API_KEY`
   - `GITHUB_INTL_TOKEN`
4. Deploy

**Production**: https://www.lianki.com (deploys from `main` branch)
**Beta**: https://beta.lianki.com (deploys from `beta` branch)

### Docker

```bash
docker-compose up
```

## Userscript Development

The Tampermonkey/Violentmonkey userscript is in `public/lianki.user.js`.

**Version Bumping Rules:**

- The pre-commit hook checks if `lianki.user.js` was modified
- If modified, you MUST bump the `@version` field
- The metadata file `lianki.meta.js` is auto-synced from the userscript header

**Key Features:**

- Inline review UI without page navigation
- Keyboard shortcuts (1-4 for ratings, 5 for delete)
- Alt+F to add current page
- Alt+Shift+V to bulk add URLs
- Media keys for video speed control (via pardon)
- Automatic URL normalization and redirect detection
- Browser prefetch for next card

## Blog System

Blog posts live in `blog/en/` and `blog/zh/` (or `blog/cn/`).

**File Naming:** `YYYY-MM-DD-slug.md`

**Frontmatter:**

```markdown
---
title: "Post Title"
date: YYYY-MM-DD
tags: [tag1, tag2]
summary: "One sentence description."
---
```

**Auto-Translation:**

- Powered by OpenAI GPT-4o
- Streaming translation UI in `/[locale]/blog` pages
- Auto-commits to GitHub via `GITHUB_INTL_TOKEN`

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run `bun fix` to format and lint
5. Commit your changes (pre-commit hook will run automatically)
6. Push to your fork
7. Open a Pull Request

## License

MIT

## Author

snomiao <snomiao@gmail.com>
