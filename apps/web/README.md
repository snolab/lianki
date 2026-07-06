# @lianki/web

Standalone Vite + React SPA — the future Lianki website, replacing the Next.js
frontend as part of the Cloudflare-native migration. Shares framework-neutral
code via `@lianki/core`.

```bash
bun run --filter='@lianki/web' dev     # http://localhost:5173, /api proxied to VITE_API_ORIGIN
bun run --filter='@lianki/web' build
```

## Status — feature pages ported

Vite + React 19 + `react-router-dom`. Pages (all session-authed against the
Worker API, typed via `@lianki/core` where shared):

`/` home · `/add` add card · `/review` FSRS review loop (1–4 keys) · `/due`
due list · `/data` YAML export/import · `/read` read materials (paginated) ·
`/roadmap` learning goals · `/ai` AI sentence generator · `/settings` mobile
exclude patterns. Session-aware nav via better-auth `get-session`.

Deployed + verified end-to-end on `lianki-cf.snomiao.workers.dev`.

## Remaining to full parity

- **i18n:** the Next app uses `next-intlayer`; port to `react-intlayer` +
  `vite-intlayer`. This is the flagged de-risk — the dictionary build on Vite
  needs its own validation pass (not yet done; do it deliberately, not rushed).
- **SEO:** meta/OG tags are in index.html. `bun run build:ssg` prerenders the
  landing route into `dist/index.html` (serves the build, renders "/" in headless
  Chromium via `scripts/prerender.mjs`, injects the static #root) — works for the
  standalone build. **WIP:** prerendering the apps/api *combined* client build
  (the deployed path) — its Cloudflare-plugin client didn't render in the static
  prerender context; needs debugging before wiring into `apps/api` deploy. Blog
  SSG is separate.
- Polish: styling/design-system pass, error/empty states, offline sync UI, and
  any long-tail Next components not covered by the pages above.

## Serve topology — decided & wired

**apps/api serves this SPA (single origin, no CORS).** `@lianki/web` exports a
mountable `Root`; `apps/api`'s client bundle (`src/client/main.tsx`) mounts it,
so `apps/api`'s Vite/@cloudflare build ships this app as Workers Static Assets
and the `lianki-cf` Worker serves it (with `/api/*` handled by the same Worker).
Run `bun run --filter='lianki-cf' dev` to serve web + api together;
`bun run --filter='@lianki/web' dev` still runs the SPA standalone against a
proxied API.
