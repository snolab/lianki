# apps/

Deployable applications in the Lianki monorepo. Libraries and tools live under
`packages/*`; shared source that hasn't been extracted yet still lives in the
root `lib/` (drained into `packages/core` over time).

Planned (incremental — see the restructure plan):

| App          | Purpose                                   | Status                  |
| ------------ | ----------------------------------------- | ----------------------- |
| `apps/api`   | Hono API Worker (Cloudflare, `lianki-cf`) | **moved** from cf-native |
| `apps/web`   | Vite + React SPA (the website)            | planned (ported from Next) |
| `apps/web-next` | Existing Next.js app (kept until DNS cutover) | still at repo root  |

`apps/api` is the former `cf-native` worker, now a workspace member sharing the
root lockfile; it still deploys as the isolated `lianki-cf` Worker via its own
`wrangler.jsonc`. The Next.js app still runs from the repo root and production
(on `main`) is untouched.
