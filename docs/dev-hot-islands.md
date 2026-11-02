# Hot islands

An island is one smart component — its own data fetching, hooks, state and
view — that the page renders built in. On the owner's page, with a live
code-run grant, the same island can instead come from the dev machine's
working tree, imported over the tailnet and swapped in place on every save.
Production renders the built-in island and nothing else.

It generalizes the debug chat's hot-load ([dev-debug-widget.md](dev-debug-widget.md))
from one widget to any named island.

| File                               | Role                                                               |
| ---------------------------------- | ------------------------------------------------------------------ |
| `lib/islands/contract.ts`          | every island, shared-state key and action, with versions           |
| `lib/islands/Island.tsx`           | `<Island>` / `island()`, the error boundary                        |
| `lib/islands/shared-state.ts`      | `useSharedState(key)`: localStorage JSON, zod-checked              |
| `lib/islands/actions.ts`           | the action bus: `sendAction`, `useIslandAction`                    |
| `lib/islands/rules.ts`             | the origin allowlist, the shared module list, module checks        |
| `lib/islands/store.ts`             | which islands are overridden now; the grant                        |
| `lib/islands/useIslands.ts`        | turns the loader on and off with the grant (mounted by DebugEval)  |
| `lib/islands/loader.ts`, `page.ts` | import, SSE, swap; `page.ts` wires the browser's real dependencies |
| `lib/islands/host-modules.ts`      | the page's module instances for `globalThis.__lkModules`           |
| `lib/islands/entry.ts`             | what the dev server builds: `islands`, `versions`, `ISLANDS_API`   |
| `scripts/dev/islands-build.ts`     | Bun.build with shared modules from the page; per-island hashes     |
| `scripts/dev/islands-server.ts`    | serve, watch, typecheck, SSE `slot-reload`; tailnet                |
| `tests/hot-islands.spec.ts`        | end to end against local dev                                       |
| `unit/islands.test.ts`             | gating, fallback, shared state, bus, loader, build                 |

## Use it

```bash
bun scripts/dev/islands-server.ts --port 5181 --tailnet /lianki-islands
#   → https://<tailnet-host>/lianki-islands/islands.js
bun scripts/dev/islands-server.ts --port 5181      # localhost only
```

**On lianki.com, use live view** ([live-view.md](live-view.md)):
`bun scripts/dev/live-view.ts on --islands /lianki-islands`, then "Live view"
in the account menu. The signed pointer replaces the key and the grant below.
The key is ignored on production since 2026-11-01; on localhost and in dev
builds, on the owner's page in debug mode, run this once in the console:

```js
localStorage.setItem("lk:slots-src", "https://<tailnet-host>/lianki-islands/islands.js");
location.reload();
// back to built-in islands:
localStorage.removeItem("lk:slots-src");
location.reload();
```

Nothing changes until an eval pairing (Allow, 8 hours) covers the page. Then
the islands are imported and replace the built-in ones. When you save a
file, the server rebuilds and typechecks. If the output changed, it sends
`slot-reload {rev, names}`, naming only the islands whose import graph
changed. The page re-imports `islands.js?v=<rev>` and swaps only those
islands. Everything above them keeps its state, and so does every other
island. The `islands.status` shared key holds what is loaded, or why it is
not: `{active, rev, names, note}`.

## Security model

On lianki.com an override needs a verified live-view pointer that names the
islands ([live-view.md](live-view.md)); its expiry is the permission. On
localhost and in dev builds, the older route needs all three of these:

1. **A live code-run grant for this page.** This is the eval pairing the
   owner approved in the pairing modal, scope `eval`, covering this page and
   not expired. DebugEval feeds `islandStore.setGrant(grantUntil(state))`
   from every hub `state`, and only on the owner's pages. Friends' pages
   never set it. The grant ends when it lapses (one local timer), when a
   state without it arrives (End), or when debug mode is turned off. A socket
   that drops while the page is hidden keeps it until one of those.
2. **`localStorage["lk:slots-src"]`**, set by hand on that device.
3. **An allowed origin.** `ISLAND_ORIGINS` in `lib/islands/rules.ts`
   allows https on `*.ts.net` (the tailnet, via `tailscale serve`, never
   funnel) and `localhost` / `127.0.0.1` / `[::1]`. Anything else is ignored,
   with a note in `islands.status`.

The grant already lets the agent run any code on the page, so hot islands
are the same power as eval, gated the same way, just more convenient.

**Production cost.** `<Island>` checks `lk:slots-src` once, when its module
loads. Without it, `Island` is a plain function that renders the built-in
component: no hook, no effect, no subscription, no network. The loader and
the module map are separate chunks that load only after all three gates
pass. A device with the key set but no grant subscribes to an in-memory
store and nothing more.

**Local dev only.** Under `next dev`, `globalThis.__lkIslandsGrant(until | null)`
sets the grant by hand, because the hub that grants code runs is not part of
`next dev`. It is compiled out of production builds.

## How it works

**One React, one router, one intlayer.** The dev build rewrites every import
listed in `SHARED_MODULES` (`lib/islands/rules.ts`) into a stub that
re-exports `globalThis.__lkModules[spec]`. That covers react, react-dom,
react/jsx-runtime, next/link, next/navigation, next/image, next-intlayer,
zod, `@/lib/auth-client`, `@/lib/debug-client`, `@/lib/dates`,
`@/lib/app-locale` and `@/lib/islands/Island`. A relative import that
resolves to one of those files is shared too. Before the first import, the
page fills `__lkModules` with its own instances (`host-modules.ts`, loaded
with `import()`). So the remote island renders inside the page's React tree,
and contexts (intlayer's, the router's), the session store and hooks all
work. Any other `react*` subpath, such as `react-dom/client`, fails the
build rather than load a second React. A test keeps the page's map and the
list equal.

**Error boundary.** Each overridden island renders inside `IslandBoundary`,
keyed by rev. If it throws, the boundary shows the built-in island, warns in
the console and posts `{ev: "island-error"}` to the devLog. The next reload
gets a fresh boundary.

**Contracts.** `IslandProps` in `contract.ts` holds each island's static
props, and `ISLAND_VERSIONS` its version. `entry.ts` declares
`islands = {…} satisfies IslandsExport`. So an island that breaks its
contract fails typecheck, and the dev server runs `tsgo` with every build:
an error in a file the islands import blocks the reload and is logged, and
the last good build keeps being served (`--no-typecheck` skips this). At
runtime, the page skips an island whose contract version differs from its
own, or which it does not know, and that island stays built in.

**CSS.** As for the widget, the Tailwind utilities that the islands' sources
use are compiled with the app's theme and injected in the `utilities` layer.
New custom CSS in `globals.css` still needs a deploy.

**Event-driven.** One `EventSource` on `<dir>/events`, `hello <rev>` on
connect (a newer rev catches up), `slot-reload` after a rebuild. The
`islands.reload` action re-imports everything on demand. Nothing polls.

## Islands: the rules

1. **The unit is a smart component.** An island owns its fetching, hooks,
   state and view, so the whole container can be replaced at once. Do not
   wrap presentational pieces that get their data from a parent.
2. **No live props.** An island takes nothing from its parent, or only the
   static values its contract lists: strings, numbers and booleans known at
   render, such as the locale or a label. The `Static<…>` type in
   `contract.ts` enforces this.
3. **Islands don't import each other.** They talk only through the
   contract:
   - **Shared state**: `useSharedState(key)` returns `[value, set]`, e.g.
     `useSharedState("islands.status")`. The value lives in localStorage as `lk:s:<key>` =
     `{v, data}`. Other tabs are told through the `storage` event, this tab
     through the CustomEvent `lk:shared-state` (`{key}`). It is SSR-safe
     (`useSyncExternalStore`; the server and the first client render see the
     default), and blocked storage falls back to memory.
   - **Actions**: `sendAction("islands.reload", {})` and
     `useIslandAction("islands.reload", handler)`, as the CustomEvent
     `lk:island-action` (`{name, payload}`).
4. **Every key and action is in `contract.ts`**, with a zod schema. A key also
   has a default, a `version` and an optional `migrate(fromVersion, raw)`.
   Reads `safeParse`. An older version is migrated, then parsed. Anything
   that fails (bad JSON, a newer version, a bad shape, a throwing migrate)
   reads as the default and is logged to the devLog, and nothing is ever
   thrown into an island. Writes go through `schema.parse`. Action payloads
   are parsed on send and safeParsed on receipt, and a misfit is dropped and
   logged. Change a shape and you bump its version, so an island built on
   either side of the change keeps working.

shared-state.ts and actions.ts are deliberately not shared modules. Their
state is localStorage and window events, so a remote island's own copy works
with the page's, and validates with its own contract version.

## The islands today

- `header.brand`: the wordmark beside the seal in the top bar (lib/brand.ts): 鏈記 (lianki.com) for zh/ja/ko, Lianki.com elsewhere; props `appName`, `locale` (contract v2).
- `words.swipeCard`, `words.swipeCue`, `words.swipeGrades`, `words.swipeFeel`
  and `words.swipeTuner`: the /words swipe's UI over its headless core. They
  read `@/lib/words/swipe-core`, a shared module, through context. See
  [swipe-core.md](swipe-core.md).
- `nav.bottom` and `nav.drawer`: the floating bottom island navigation and
  the rows above the nav list (pinned, recent, breadcrumbs). See
  [bottom-nav.md](bottom-nav.md).

## Add an island

1. Make the component self-contained: it fetches what it needs and reads and
   writes shared state through `useSharedState`. It must be a client
   component (`"use client"` somewhere above or in it).
2. In `contract.ts`, add its static props to `IslandProps` and set
   `ISLAND_VERSIONS[name] = 1`. Add any new shared keys to `SHARED` and any
   actions to `ACTIONS`.
3. Where it is used: `const X = island("area.name", Component)` and render
   `<X {...staticProps} />`, or `<Island name="area.name" component={Component} props={…} />`.
4. In `lib/islands/entry.ts`: `import { Component } from "…"` and
   `"area.name": Component` inside `islands`. Use one import per island, so
   the server can tell which islands a save touches.
5. Deploy once. The page only knows islands, keys and versions that it
   shipped with.

## Limits

- **Client components only.** A server component cannot be an island: its
  code never reaches the browser. Wrap the client part.
- **No new server code.** An island cannot add server actions, routes, API
  handlers or middleware. It can only call what is deployed.
- **New intlayer keys need a deploy.** The dictionaries are compiled into the
  page, so `useIntlayer` in a remote island reads the deployed content.
- **New islands, keys, actions or contract versions need a deploy.** The page
  checks against its own `contract.ts`.
- **Shared modules only.** A stateful module that is not in
  `SHARED_MODULES` (a module-level cache, a store, a context defined in app
  code) is bundled as a second copy, with its own state. Add it to the list
  and to `host-modules.ts`, then deploy.
- **State inside a swapped island is reset.** A new rev re-mounts that
  island. Keep what must survive in shared state.
- **next/image, next/link and next/navigation** are shared, so they behave
  like on the page. `next/dynamic`, `next/headers`, `next/server` and
  `next/cache` are server-side or compiler-bound and are not available to
  islands.

## Testing

```bash
bun test unit/islands.test.ts
bun run dev   # or: bunx next dev -p <port>
LIANKI_URL=http://localhost:<port> bunx playwright test tests/hot-islands.spec.ts
```

The Playwright test runs the islands server on localhost with a throwaway
entry and grants the page with `__lkIslandsGrant`. It checks that nothing is
hot before the grant, that the override renders with the page's React
(`useState`), and that a save swaps it with no page reload. It also checks
that a throwing island falls back to the built-in one, that withdrawing the
grant restores the built-in island, and that an origin off the allowlist is
ignored. It is not part of `qa:all`, which runs a production build where the
dev grant hook does not exist.
