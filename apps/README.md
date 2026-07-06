# apps/

Deployable applications in the Lianki monorepo. Libraries and tools live under
`packages/*`; shared source that hasn't been extracted yet still lives in the
root `lib/` (drained into `packages/core` over time).

Planned (incremental — see the restructure plan):

| App          | Purpose                                   | Source today            |
| ------------ | ----------------------------------------- | ----------------------- |
| `apps/api`   | Hono API Worker (Cloudflare)              | `cf-native/src/worker`  |
| `apps/web`   | Vite + React SPA (the website)            | (new; ported from Next) |
| `apps/web-next` | Existing Next.js app (kept until DNS cutover) | repo root          |

Nothing has been moved here yet — this directory exists so the `apps/*` Bun
workspace glob has a home. The current Next.js app still runs from the repo root
and production (on `main`) is untouched.
