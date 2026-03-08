# Lianki - Development Guide

This guide is for developers who want to run, modify, or contribute to Lianki.

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

The project uses Husky for pre-commit hooks:

- Runs `oxlint --fix` and `oxfmt` automatically
- Runs TypeScript type checking
- Auto-syncs `lianki.meta.js` from `lianki.user.js` metadata
- Validates userscript version bump

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
