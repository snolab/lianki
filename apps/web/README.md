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

## Serve topology — decided & wired

**apps/api serves this SPA (single origin, no CORS).** `@lianki/web` exports a
mountable `Root`; `apps/api`'s client bundle (`src/client/main.tsx`) mounts it,
so `apps/api`'s Vite/@cloudflare build ships this app as Workers Static Assets
and the `lianki-cf` Worker serves it (with `/api/*` handled by the same Worker).
Run `bun --cwd apps/api run dev` to serve web + api together; `bun --cwd apps/web
run dev` still runs the SPA standalone against a proxied API.
