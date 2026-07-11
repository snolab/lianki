# CF-native cutover runbook (issue #98, phase 8)

The Cloudflare-native app (`apps/api` Worker serving the `apps/web` SPA) is
feature-complete and live on staging: **https://lianki-cf.snomiao.workers.dev**.
Production (`lianki.com`) still runs the Next.js app on Vercel. This is the
final, **user-gated** step to move production to the Worker. Keep Vercel as an
instant DNS rollback until soaked.

## 1. Worker secrets (`wrangler secret put <NAME>` in `apps/api/`)

The Worker needs the same secrets the Next app used. Required for full function:

- `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (= the production origin, e.g. `https://lianki.com`)
- `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`
- `OPENAI_API_KEY` — **currently invalid**; the AI routes (ai-vocab, polyglot,
  self-intro, translate, tts, roadmap/generate) 500 without a valid key.
- `RESEND_API_KEY` (magic-link email; else it console.logs the link)
- `SLACK_WEBHOOK_URL` (contact form), `SLACK_SIGNING_SECRET` + `SLACK_BOT_EMAIL` (slack/events)
- `YOUTUBE_API_KEY` (youtube import)

D1 (`DB`) + R2 (`BLOBS`) bindings are already in `wrangler.jsonc` and point at
production data.

## 2. OAuth redirect URIs (Google Cloud Console + GitHub OAuth app)

better-auth's callback path is `/api/auth/callback/<provider>`. Add these
redirect URIs to the **same** OAuth clients the Next app uses (email = same
user, so reusing the clients keeps one consent screen):

- `https://lianki.com/api/auth/callback/google` and `.../github`
- `https://www.lianki.com/api/auth/callback/google` and `.../github`
- (staging, optional) `https://lianki-cf.snomiao.workers.dev/api/auth/callback/google` and `.../github`

Note: `lianki.com/api/auth/callback/google` may already be registered from the
NextAuth era (same path) — verify, and add GitHub + any missing.

## 3. Point production at the Worker

Add a **Custom Domain** to the `lianki-cf` Worker for `lianki.com` (and `www`)
via `wrangler` or the dashboard (Workers → lianki-cf → Settings → Domains &
Routes → Custom Domain). This updates DNS to the Worker.

Rollback: remove the custom domain / repoint DNS to Vercel — instant.

## 4. Smoke test (after cutover)

- `/` renders (prerendered landing), `/blog` + a post render.
- Sign in (magic-link + Google/GitHub) → `/profile` shows your email + tier.
- Add a card (`/add`), review (`/review`), due list (`/due`), export/import (`/data`).
- `/api/health` → `{ok:true,backend:"d1"}`.

## Not yet ported

- `import/anki` (server-side `.apkg` parsing) — needs a Workers unzip + WASM
  sqlite parser; the client-parsed `import/anki-client` path works.
- Blog locales other than English (the 16 non-`en` dirs) — `apps/web/src/lib/blog.ts`
  currently globs `blog/en/*.md` only.
