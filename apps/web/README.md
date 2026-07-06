# @lianki/web

Standalone Vite + React SPA — the future Lianki website, replacing the Next.js
frontend as part of the Cloudflare-native migration. Shares framework-neutral
code via `@lianki/core`.

```bash
bun --cwd apps/web run dev     # http://localhost:5173, /api proxied to VITE_API_ORIGIN
bun --cwd apps/web run build
```

## Status — shell

This is a **shell**, not full parity yet. Proven so far:

- Vite + React 19 + `react-router-dom` (nested routes under an `<App/>` shell).
- A real data page (`/due`) calling `/api/fsrs/due` and rendering results, typed
  with the shared `FSRSNote` from `@lianki/core`.
- Dev `/api` proxy to a Lianki API origin (`VITE_API_ORIGIN`, default prod).

## Roadmap to parity

- Port the ~36 client components from the Next app (`app/[locale]/…`).
- **i18n:** the Next app uses `next-intlayer`; port to `react-intlayer` +
  `vite-intlayer` (a known de-risk — validate the dictionary build on Vite).
- **Auth:** wire better-auth client (session cookie is already sent).
- **SEO:** landing + blog need prerender/SSG (Vite SPA is client-only).

## Open decision — serve topology

Two options for production; not yet chosen:

1. **apps/api serves this build** — the `lianki-cf` Worker points its Static
   Assets binding at `apps/web/dist`. Single origin, no CORS, one deploy. (Matches
   the combined Worker pattern apps/api already uses for its own client stub.)
2. **Separate deploy** — web deploys independently (Pages/Worker) and calls the
   api Worker cross-origin (needs CORS).

Option 1 is the CF-idiomatic default; confirm before wiring the prod build.
