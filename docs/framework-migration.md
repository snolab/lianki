# Framework migration: off Next.js, without a rewrite branch

Status: **plan, nothing built** (2026-10-31). Owner request, Slack
2026-10-31 00:54–00:55 JST: development speed matters most. If Next.js slows
it down, move to a freer framework such as Vite, and get out of vendor
lock-in.

**Recommendation.** Put a small **Vite-built front Worker** (`workers/edge`,
built with `@cloudflare/vite-plugin`, with Hono at the top) in front of
today's OpenNext Worker. Move the API to Hono there, then move the pages to
**React Router 7 in framework mode**, one route at a time on `main`. Each PR
deletes the Next copy of what it moves. Anything not yet moved falls through
to the `lianki` Worker over a service binding, the same way `lianki-voice`
already works. The estimate is **about 100–130 agent hours** in total. The
first step is a 4-agent-hour spike that measures the phone dev loop and cold
start before anything else is committed (section 7).

The first phase, the API on a small Worker, pays off whichever framework the
pages end up on. That makes it the no-regret move.

## 1. Where we are

| Fact                                                                                                                                                                        | Source                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `lianki.com/*` is the `lianki` Worker: Next 16.4 built by `@opennextjs/cloudflare` 1.20, D1 `lianki`, R2 `lianki-blobs`, better-auth 1.7 on Kysely/D1                       | `wrangler.jsonc`, `package.json`, AGENTS.md           |
| `handler.mjs` was 22.2 MB, and 15.8 MB after better-auth went behind one lazy chunk                                                                                         | #239 (2026-10-29)                                     |
| A new isolate of the ~23 MB main Worker takes **1–2.5 s to first byte**. One voice request in ten hit one before `lianki-voice` took that path                              | `docs/workers-ai.md`, `lianki_metrics` 2026-10-30     |
| Three small Workers already sit beside it: `lianki-monitor`, `lianki-push`, and `lianki-voice`, which owns `lianki.com/api/words/tts*` and passes everything else to `MAIN` | `workers/*`, `deploy-worker.yml`                      |
| From merge to production takes about 6–7 min: CI 4–5 min (`qa:all` runs a full OpenNext build), then deploy about 2 min                                                     | `gh run list`, 2026-10-30                             |
| The phone loop today is hot islands and the debug widget: a client component from the dev machine is hot-swapped into the production page over the tailnet, in seconds      | `docs/dev-hot-islands.md`, `docs/dev-debug-widget.md` |
| The hot core (cordis-style kernel) is designed but not built. It is plain TypeScript and imports no framework                                                               | `docs/hot-core.md`                                    |
| Vercel no longer builds anything. The lock-in left is **Next.js, plus OpenNext's coupling to Next's versions** (OpenNext needed Next ≥ 16.2.6)                              | AGENTS.md, `docs/cf-d1-migration.md`                  |

### What uses Next today (grep, 2026-10-31)

| Next API                                                                                | Files                                       | How hard to replace                                                                    |
| --------------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------- |
| `next/server` (`NextRequest`, `NextResponse`)                                           | 51                                          | mechanical: `Request` / `Response` / Hono `c.json`                                     |
| `next` (`Metadata` types; `generateMetadata` in 32 files)                               | 33                                          | RR7 `meta` export, or one `<head>` helper over `lib/hreflang.ts`                       |
| `next/headers` (`cookies()`, `headers()`)                                               | 29                                          | read them from the request (loader `request`, Hono `c.req`)                            |
| `next/navigation` (`useRouter`, `usePathname`, `redirect`, `notFound`)                  | 24                                          | `react-router` hooks, `redirect()`, `throw data(null, 404)`                            |
| `next/link`                                                                             | 15                                          | `react-router` `Link`                                                                  |
| `next/cache` (`revalidateTag`, `unstable_cache`)                                        | 3                                           | the Cache API or KV, or no cache at all (D1 is close)                                  |
| `next/image`                                                                            | 2                                           | `<img>` (only avatars and the logo)                                                    |
| `next/dynamic`                                                                          | 1                                           | `React.lazy`                                                                           |
| `"use server"` server actions                                                           | 2 (`list/actions.ts`, `sign-in/actions.ts`) | a POST endpoint or an RR7 `action`                                                     |
| `middleware.ts` (www→apex, `/cn`→`/zh`, legacy `/ja/list`, the locale header, intlayer) | 1                                           | Hono middleware. The logic is already plain TypeScript in `lib/app-locale.ts`          |
| `better-auth/next-js` (`nextCookies`, `toNextJsHandler`)                                | 2                                           | `auth.handler(request)`. `nextCookies` only exists for server actions                  |
| Route handlers `app/**/route.ts`                                                        | 54                                          | Hono routes. Most bodies are already `Request → Response`                              |
| Pages / layouts                                                                         | 37 / 4                                      | thin: the 37 `(app)` page files total 982 lines, and each one wraps a client component |
| `"use client"` components                                                               | 77                                          | move unchanged                                                                         |
| `next-intlayer` (16 locales)                                                            | —                                           | `react-intlayer` + `vite-intlayer`. Proven on the cf-native branch (81c24b0, f392dac)  |
| `public/sw.js`                                                                          | 1                                           | keep it. It special-cases `/_next/static/`, so it needs a rule for Vite's `/assets/`   |

So the lock-in is wide but shallow. About 115 files import `next/*`, nearly
all at the edges (request and response, metadata, links). The business logic
is already framework-neutral in `lib/`: the D1 repos, FSRS, auth, the
words/swipe core and islands.

## 2. Why the cf-native rewrite (`apps/**`) was shelved

Issue #98, branches `cf-native` and `cf-native-rebased`, 2026-06-29 to
2026-09-09:

- **Its stack was this candidate**: Hono on Workers, a Vite + React SPA with
  `react-router-dom`, Workers Static Assets, better-auth on Hono, intlayer
  through `react-intlayer`, and a headless-Chromium prerender for landing and
  blog SEO. It was close to feature-complete on staging, with 28 of 29 backend
  routes ported, and its Worker was **373 KiB gzipped**. The goal then was to
  fit the free plan's 3 MiB limit, which OpenNext's 4.49 MiB missed.
- **It never shipped because it was a parallel rewrite on a long-lived
  branch.** `main` kept moving: watch-time tracking, review order, the
  Mongo→D1 load fixes, the userscript. By September, `cf-native-rebased` carried
  63 commits that were not on `main`, and needed a "reconcile with main's post-rebase layout"
  commit just to keep up. The OpenNext path reached cutover in days because it
  reused all of the existing code. The decision was made in #154
  (2026-10-06 02:03 JST): "OpenNext is the cutover path; cf-native is
  shelved." The site cut over on 2026-10-06.
- What is left of it: `packages/core` (`@lianki/core`), this repo's monorepo
  layout, and the D1 schema it pushed (`0002`, `0003`). The Hono ports on the
  branch are a useful **reference** for porting routes. They are not a base to
  merge, since they are 3–4 months stale.

**The lesson this plan is built on:** never again a rewrite on a branch.
Every step lands on `main`, takes production traffic, and deletes what it
replaces.

## 3. Candidates

Scores run from ★ (poor) to ★★★ (good).

|                            | A. Vite + RR7 framework mode + Hono, strangler (recommended)              | B. TanStack Start on Workers                         | C. Plain Vite SPA + Hono + prerender (the cf-native design)                      | D. Stay on Next, fix the pain                            |
| -------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Phone dev loop             | ★★★ Vite HMR with workerd in dev                                          | ★★★ same Vite core                                   | ★★★ same, with no SSR to reload                                                  | ★★ fast HMR, but `next dev` is not workerd               |
| Hot islands / hot core fit | ★★★ swap `next/*` for `react-router` in `SHARED_MODULES`                  | ★★★ same, `@tanstack/react-router`                   | ★★★                                                                              | ★★★ already built                                        |
| SSR / SEO / 16 locales     | ★★★ per route: prerender, SSR or client-only                              | ★★★ SSR, streaming, prerender                        | ★★ headless-Chrome prerender for public pages only. It was fragile on the branch | ★★★                                                      |
| PWA / service worker       | ★★★ keep `sw.js`, add a rule for `/assets/`                               | ★★★                                                  | ★★★                                                                              | ★★★                                                      |
| better-auth                | ★★★ `auth.handler` in Hono (done once on the branch)                      | ★★★                                                  | ★★★                                                                              | ★★★                                                      |
| D1 / R2 in dev             | ★★★ real bindings in workerd through the Vite plugin                      | ★★★                                                  | ★★★                                                                              | ★★ through `initOpenNextCloudflareForDev` proxies        |
| Bundle / cold start        | ★★★ small API Worker, no Next runtime, prerendered pages served as assets | ★★★                                                  | ★★★ smallest                                                                     | ★ 15.8–23 MB. Splitting routes out helps, but Next stays |
| Lock-in                    | ★★★ MIT, Request/Response, a Vite plugin, runs anywhere                   | ★★ server functions are TanStack RPC                 | ★★★                                                                              | ★ Next plus OpenNext version coupling                    |
| Maturity                   | ★★★ stable. Remix lineage, with Cloudflare's own template                 | ★★ younger, the API still moves                      | ★★★                                                                              | ★★★                                                      |
| Migration cost             | ~100–130 agent hours, in increments                                       | ~110–140 agent hours (more server-function rewiring) | ~90–110 agent hours, plus the SEO prerender work                                 | ~15–25 agent hours for the cold-start fixes only         |

### A. Vite + React Router 7 (framework mode) + Hono, behind one front Worker

- **Phone loop.** `vite dev` with `@cloudflare/vite-plugin` runs the Worker
  (Hono, RR7 SSR, the API) inside **workerd**, the production runtime, with
  local D1 and R2 from `.wrangler/state`. A client edit is a React Fast
  Refresh with state kept. A server edit re-runs only the changed modules,
  with no restart. Put it on the tailnet with
  `tailscale serve --bg --https=<port> http://localhost:5173`, and set
  `server.allowedHosts: [".ts.net"]` and
  `server.hmr = { protocol: "wss", clientPort: <port> }`. Then the whole
  app, not just islands, runs on the phone from the working tree, and a save
  appears in well under a second. The spike measures this (section 7). One
  cost to watch: dev serves unbundled ESM, so the phone's first load fetches
  hundreds of modules. Over the tailnet with HTTP/2 that should be fine, and
  the spike measures it too.
- **Hot islands.** They keep working against production. The islands build is
  `Bun.build` and does not depend on the framework. During the move, an island
  must not import `next/*` or `react-router` directly. It uses a small
  `@/lib/nav` adapter (`Link`, `useNavigate`, `usePathname`) that each host
  fills in. That adapter becomes the shared module in place of `next/link` and
  `next/navigation`.
- **Hot core.** No change: the kernel is plain TypeScript. In the Vite loop,
  `import.meta.hot.accept` on a core module can call the same `swap.ts`
  protocol, so dev and production swaps behave alike.
- **SSR / SEO.** RR7 picks per route. Landing and blog, in 16 locales, are
  **prerendered** at build time (`prerender` in `react-router.config.ts`).
  They are served from Workers Static Assets and never wake the Worker, so they
  cannot cold-start. App routes are SSR (they are signed-in pages), or
  client-only where SSR adds nothing. `lib/hreflang.ts` stays as the one place
  for alternates.
- **Auth.** better-auth mounts in Hono on the same D1 tables, with the same
  secret and cookie. A session made by Next is valid on the new Worker and
  the other way round, which is what lets the two coexist. `nextCookies` goes
  once the two server actions are ported.
- **Cold start.** The API Worker carries no Next runtime, which is most of
  `handler.mjs`. The cf-native Worker was 373 KiB gzipped. Heavy dependencies
  (better-auth, the AI SDKs, jszip) stay behind `import()`, as #239 did.
  Prerendered pages cost no Worker time at all.
- **Lock-in.** React Router is MIT. Loaders and actions take a `Request` and
  return a `Response` or data. The Vite plugin is the only build coupling, and
  Hono runs on any runtime.

### B. TanStack Start

TanStack Start is equal on the dev loop and on SSR, and its routing has the
best types. But **server functions are TanStack's own RPC**, a lock-in like
server actions, and the framework is younger, so its API still moves between
minors. Choose it if fully typed search params and links turn out to matter
more than stability. Hono for the API works the same under either.

### C. Plain Vite SPA + Hono + prerender

This is the cf-native design: the smallest Worker and the simplest mental
model. But SEO depends on a headless-Chromium prerender step, which needed
three fixes on the branch. And every signed-in page renders client-side only,
which means a blank first paint on a slow phone network. A is a superset of
C: RR7 framework mode can run any route client-only (`ssr: false` per app, or
`clientLoader`), so nothing is lost by choosing A.

### D. Stay on Next and fix the pain points

- The cold start can be cut by moving hot paths out of Next into small
  Workers, as `lianki-voice` did. **That is phase 1 below**, so it is not
  wasted.
- The phone loop already works through hot islands, and `next dev` over the
  tailnet (`allowedDevOrigins`) would give the whole app on the phone. But
  `next dev` does not run workerd. Runtime differences only show up in
  `qa:all`'s OpenNext build. That build is a large part of the 4–5 min CI.
- The lock-in stays: Next, and OpenNext, which has to follow Next's releases.
  Cheapest now, but it does not answer the owner's second goal.

## 4. Recommended path: strangle Next behind one Worker

```
            lianki.com/api/words/tts*  → lianki-voice (unchanged)
            lianki.com/*               → lianki-edge   (new, Vite-built)
                                           ├─ Hono: ported /api/* routes
                                           ├─ RR7: ported pages, /assets/*
                                           ├─ prerendered landing + blog (static assets)
                                           └─ everything else → MAIN.fetch() → lianki (OpenNext)
```

The routing order inside `lianki-edge`: first a Hono route that has been
ported. Then a path in the `PORTED_PAGES` list goes to the RR7 request
handler. Anything else is `c.env.MAIN.fetch(c.req.raw)`. A service binding
call stays on the same machine and adds next to nothing. Next's `/_next/*`
and Vite's `/assets/*` do not collide. Rolling back one route means taking it
off the list. Rolling back everything means putting the zone route back on
`lianki`.

**Rules for every PR:**

1. Move one route or one feature, and **delete its Next copy in the same
   PR**. Never keep two live copies.
2. Code shared by the two hosts lives in `lib/` and must not import `next/*`.
   An oxlint `no-restricted-imports` rule on `lib/**` enforces this from
   phase 1.
3. Wire contracts stay byte-for-byte: the userscript and the extension call
   `/api/*`. `scripts/qa/qa-worker.mjs` (the differential gate) is extended to
   diff each ported route against the old one before the switch.
4. `qa:all` builds and runs both Workers until Next is gone.

### Phases (agent hours)

| Phase                     | What                                                                                                                                                                                                                                                                                                                                                                                                                             | Agent hours                                           | Done when                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------ |
| **0. Spike**              | Section 7. Measure, then go or no-go                                                                                                                                                                                                                                                                                                                                                                                             | 4                                                     | numbers recorded here                                        |
| **1. Front Worker + API** | `workers/edge` on the zone route. Hono middleware for www/`/cn`/locale. better-auth on Hono. Port the 54 route handlers by group: `fsrs` (the userscript's hot path) first, then `words`, `preferences`, `token`, `export`/`import`, `roadmap`, `read`, `ai-sentences`/`polyglot`/`self-intro`/`translate`, `payments`/`membership`/`invite`/`gift-codes`, `slack`, `dev`/`debug`. Use the cf-native branch's ports as reference | 25–30                                                 | no `app/api/**` left. API cold start under 200 ms (measured) |
| **2. App pages on RR7**   | The `(app)` shell, layout and auth guard. `react-intlayer`. The `@/lib/nav` adapter, and islands' `SHARED_MODULES`. Pages in the order the owner works on them: `/words`, `/alphabet`, `/list`, `/next`, then the rest. The two server actions become actions                                                                                                                                                                    | 40–55                                                 | no `app/(app)/**` left                                       |
| **3. Public pages**       | `[locale]` landing and blog, prerendered for 16 locales. Metadata, hreflang, sitemap, OG. Diff a crawl of every public URL against the old one                                                                                                                                                                                                                                                                                   | 12–16                                                 | crawl diff is empty, Search Console clean                    |
| **4. Remove Next**        | Delete `next`, `next-intlayer`, `@opennextjs/cloudflare`, `middleware.ts` and `open-next.config.ts`, and the `MAIN` fallback. `sw.js` rules for `/assets/`. Rewrite `qa:all` and CI. Update AGENTS.md, DEVELOPMENT.md and the docs that name Next                                                                                                                                                                                | 8–12                                                  | one Worker, one build                                        |
| **Total**                 |                                                                                                                                                                                                                                                                                                                                                                                                                                  | **≈ 90–120, plus ~10 for review and fixes ≈ 100–130** |                                                              |

A **big bang** would cost about the same in code, 80–100 agent hours. It
would add a frozen-feature window or a drift reconciliation, and one risky
cutover. That is exactly the cf-native failure. It is not recommended.

When the payoff arrives:

- **After phase 1**: the userscript's and words' API calls stop paying Next's
  cold start.
- **During phase 2**: the whole app runs on the phone from `vite dev`.
- **After phase 3**: public pages never cold-start.
- **After phase 4**: CI drops the OpenNext build.

## 5. Risks

| Risk                                                        | Mitigation                                                                                                                                                       |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drift between two hosts, as with cf-native                  | All on `main`. Every PR deletes the Next copy, so there is never a parallel tree                                                                                 |
| Months of two frameworks: two builds in CI, two dev servers | Phases 1–2 are the long part. Keep `next dev` for unported pages only, and remove it in phase 4                                                                  |
| Sessions differ between hosts                               | One better-auth config (`auth-impl.ts`), one secret, one D1. A test signs in on one Worker and reads the session on the other                                    |
| intlayer on Vite                                            | It worked on cf-native with `build.optimize: false` and an `@intlayer/dictionaries-entry` alias (f392dac). Bring that config over                                |
| SEO regression in 16 locales                                | Phase 3's crawl diff (status, `<title>`, meta, hreflang, canonical) gates the switch                                                                             |
| The service worker caches the wrong paths                   | Give `sw.js` an `/assets/` rule in the PR that ships the first RR7 page. Test offline `/words` as `words-audio-disk.test.ts` does                                |
| `revalidateTag` / `unstable_cache` behave differently       | 3 call sites. Replace with an explicit Cache API key per user, or drop them; D1 reads are cheap                                                                  |
| The zone route switch to `lianki-edge`                      | It is the one infra step, and it needs the owner's approve. The deploy token already attaches `lianki-voice`'s route. Rollback: point the route back at `lianki` |
| RR7 itself is a new dependency                              | MIT, Request/Response based. Loaders are plain functions that are easy to move again                                                                             |
| Vite dev's first load on a phone is slow (many modules)     | Measured in the spike. If it hurts, pre-bundle the heavy dependencies (`optimizeDeps.include`) or use Vite's bundled dev mode                                    |

## 6. What does not change

The D1 schema and data, R2, the userscript and extension (`/api/*`
contracts), better-auth's tables, `lianki-voice`, `lianki-push` and
`lianki-monitor`, hot islands and the debug widget (only their shared-module
list changes), the hot core design, `@lianki/ui-state`, the 16 intlayer
dictionaries, and `public/sw.js` (one extra rule).

## 7. First step: the spike (≤ 4 agent hours)

Goal: real numbers for the owner's main criterion before any route moves. It
changes nothing in production.

1. **Scaffold `workers/edge`** with Vite, `@cloudflare/vite-plugin`
   and Hono, and a `MAIN` service binding to `lianki`. The default handler is
   `MAIN.fetch(request)`. Deploy only to `lianki-edge.<account>.workers.dev`,
   with no zone route. (1 h)
2. **Port one real endpoint**: `GET /api/preferences`, with the session read
   through `auth-impl.ts` and data through `lib/repos`. Diff it against the
   Next route with `qa-worker.mjs`. This proves auth and D1 sharing. (1 h)
3. **One RR7 framework-mode route**, `/lab/vite`, rendering one existing
   client component (for example the `/words` list picker) with intlayer. (1 h)
4. **Measure and write the numbers into this doc** (1 h):
   - **Phone HMR**: `vite dev` over `tailscale serve`, save to visible on the
     owner's iPhone. Time it with the eval channel's devLog timestamps. Do the
     same for `next dev` over the tailnet as the baseline.
   - First load on the phone in dev (module count, seconds).
   - Production Worker size, and cold time to first byte on workers.dev,
     against the main Worker's 1–2.5 s.
   - Dev server start time, Vite against Next.

Go if the phone HMR is at least as fast as Next's and the cold start is
clearly lower. Then phase 1 starts with `/api/fsrs`. If not, fall back to D:
keep Next and move only the hot API paths to small Workers.
