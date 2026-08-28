# Dev userscript loader (install once, hot-reload over a Cloudflare tunnel)

Edit `src/lianki.user.ts`, save, and every attached browser — including a phone
on mobile data — runs the new build within a second. Nothing is reinstalled in
the userscript manager after the first time.

```bash
bun run dev:loader                            # quick tunnel; bundle talks to lianki.com
bun run dev:loader --app http://localhost:3000  # ...talks to your local Next dev server
bun run dev:loader --origin https://dev.lianki.com   # you run a named tunnel yourself
bun run dev:loader --no-tunnel --port 3003    # localhost only
```

It prints an install link once the tunnel is actually routable. Open it in the
target browser, install, done — after that only the bundle changes.

| File                               | Role                                                             |
| ---------------------------------- | ---------------------------------------------------------------- |
| `scripts/dev-userscript-server.ts` | bundles, watches, long-polls, spawns the tunnel, collects errors |
| `scripts/dev-loader.user.js`       | the loader **template** — placeholders filled in per request     |
| `unit/dev-loader.test.ts`          | executes the loader against stubbed GM APIs                      |

`public/loader.user.js` is a separate, older loader: it is published on
lianki.com and re-fetches from vite on `:3002` on every page load. This one is
served only by your dev server and is pushed to.

## Architecture

```
src/lianki.user.ts ──Bun.build──> dev server :3003 ──cloudflared──> https://<host>
                                        │                              │
                                        │  GET  /loader.user.js  <──── installed once
                                        │  GET  /wait?id&rev     <──── long poll, parked
                                        │  GET  /bundle.js?id&rev<──── on rev change
                                        │  POST /error?id        ────> dev log
```

The loader is hand-written with **no build step**. It is installed once and
never changes; everything that changes lives in the bundle it fetches. Keep it
dependency-free — a second build target complicates the pre-commit hook, and
nothing typechecks it (see _Testing_ below).

The server rebuilds with `Bun.build` (~15 ms) on any change under `src/`, hashes
the output for a `rev`, and only wakes parked clients when that hash actually
changed — a comment-only edit rebuilds but pushes nothing, because the bundler
strips comments and the output is identical.

### Endpoint contract

| Endpoint                            | Behavior                                                                                                                                                                                                                                                               |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /loader.user.js`               | The loader itself. Also the `@downloadURL`/`@updateURL`, so the manager can update it.                                                                                                                                                                                 |
| `GET /wait?id=<cid>&rev=<rev>`      | **Long poll.** Holds the request open while `rev` equals the current build rev; responds with the new rev the moment a rebuild lands. Must return before the client's `timeout` (loader uses 35 s — resolve with the current rev at ~30 s and let the client re-poll). |
| `GET /bundle.js?id=<cid>&rev=<rev>` | The complete IIFE bundle as plain JS. Not an HMR shim — the loader only evals.                                                                                                                                                                                         |
| `POST /error?id=<cid>`              | JSON `{what, detail, page}` sink; print to the dev console.                                                                                                                                                                                                            |

`id` is a stable per-browser client id so the server log can say _which_ attached
client broke.

### Cloudflare tunnel

`bun run dev:loader` spawns a **quick tunnel** (`cloudflared tunnel --url
http://localhost:<port>`) and bakes the hostname it prints into the loader it
serves. No Cloudflare account or login is needed. Install `cloudflared` first:

```bash
curl -fsSL -o /usr/local/bin/cloudflared \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x /usr/local/bin/cloudflared
```

A quick tunnel's `https://<random>.trycloudflare.com` dies with the process, and
the installed loader has it baked in — so every restart means reinstalling. For
an install that survives restarts, run a **named** tunnel at a stable hostname
and point the server at it with `--origin`:

```bash
cloudflared tunnel login                       # once, opens a browser
cloudflared tunnel create lianki-dev
cloudflared tunnel route dns lianki-dev dev.lianki.com
cloudflared tunnel run --url http://localhost:3003 lianki-dev
bun run dev:loader --origin https://dev.lianki.com
```

A stable host also means `@connect dev.lianki.com` is granted once instead of
re-prompting per hostname.

**Registration is not reachability.** cloudflared prints the hostname several
seconds before the edge routes it, so the server probes its own public URL
before printing the install link. If the probe fails it still prints, with a
warning — usually the tunnel is fine and the local resolver simply has not
picked up the fresh name (a Docker `127.0.0.11` resolver in particular will
serve AAAA-only or nothing for a minute or more). Test from the target browser
before debugging the server.

### What the bundle talks to

The bundle derives its API origin from `GM_info.script.downloadURL`. Under the
loader that field would be the _tunnel_, sending every API call to the dev
server, so the loader **shadows `GM_info`** with `--app` (default
`https://lianki.com`). The dev server serves builds; the app serves the API.
Aim the bundle at a local Next dev server with `--app http://localhost:3000`.

## Loader rules

Each of these came from a real failure. Do not "simplify" one away without
reproducing what it prevents.

**Header**

- Give the loader its **own `@name` + `@namespace`** (`[dev] Lianki @dev`).
  Sharing production's pair makes a manager treat it as an _update_ to the
  installed Lianki rather than a separate script.
- Grant **every GM API the bundle uses**, not just the loader's own. The bundle
  runs inside the loader's grants, not its own header's.
- `@run-at document-start`, so the loader is polling before the page settles —
  but see the DOM wait below.
- `@connect` every origin the loader may talk to; `@downloadURL`/`@updateURL`
  point at `/loader.user.js` on the tunnel host.

**Scope and evaluation**

- Bail immediately when `window.self !== window.top`. The bundle no-ops in
  subframes anyway, so without this every iframe downloads and evals ~120 KB.
- Use **direct `eval(code)`**. It inherits the enclosing function's scope chain,
  which is where the manager binds `GM_*`. `new Function()` and indirect eval
  (`(0,eval)`) evaluate at realm global scope, where those bindings may be
  unreachable — the bundle dies on its first `GM_getValue`.
- **Trusted Types fallback, string first.** Under ScriptCat the userscript shares
  the page realm, so a document sending `require-trusted-types-for 'script'`
  (YouTube) makes `eval` of a string throw `EvalError`. Only _then_ retry through
  `trustedTypes.createPolicy(...).createScript(code)`. Doing it up front breaks
  every other site: where Trusted Types are not enforced, `eval` of a non-string
  returns the object unevaluated instead of running it.
- **`unsafe-eval`-less CSP is terminal** (e.g. translate.google.com). Set a
  `blocked` flag, report once, stop the poll loop. Retrying is pure noise.
- The bundle is written for `document-end` (it appends to `document.body`), so
  hold the eval until `DOMContentLoaded` when `document.readyState === "loading"`.
- Shadow `GM_info` with the version parsed from the fetched build. Left as the
  loader's own version, the bundle's update check compares against the server's
  version header, concludes it is permanently stale, and prompts on every page.

**Caching and rev tracking**

- Cache the bundle in `GM_setValue` keyed by rev. Every navigation starts a fresh
  loader with no in-memory rev; without the cache each page load refetches the
  whole bundle to run identical code.
- **Advance `rev` only after a successful eval.** Setting it first means a failed
  eval marks the rev current, the next long poll matches and parks, and that tab
  is wedged until reload.
- Store loader keys under their **own namespace** (`lianki_devclient_id`,
  `lianki_devbundle_rev`), _not_ the app's `lk:` prefix. With `lk:`-prefixed keys
  ScriptCat handed back Mongo ObjectIds belonging to real notes (`lk:c:<id>`), so
  every page load registered as a brand-new client.

**Error reporting** — the point is that failures show up in _your_ terminal, not
in a console on a phone nobody is reading.

- Hook `console.error` and forward messages matching the app's own prefixes
  (`[Lianki]`, `[lianki dev`). `window.onerror` only sees _uncaught_ throws; the
  failures that actually get reported by hand ("Login required (got: `<html>`…)",
  failed syncs) are caught and logged, so the dev log looked clean while the
  script was visibly broken. Filter by prefix — these pages also run uBlock,
  Grammarly and the site's own code.
- Guard re-entrancy (`report()` is reachable from the `console.error` hook) and
  cap reports per minute (~30), or one per-frame failure floods the server.
- On `window.error`: ignore events whose `filename` is another script; when there
  is no filename, forward only if the message names us. Drop known browser noise
  (`ResizeObserver loop`, bare `Script error.`, `NotAllowedError: play()`).
- Also forward `unhandledrejection`.

**Backoff**

- Golden-ratio backoff (×1.618, capped at 60 s) on poll failure, and **name the
  origin in the warning**. With more than one dev loader ever installed, a bare
  "network error" cannot tell you which tunnel died — a stale install pointing at
  a dead tunnel looks exactly like a live one failing.

## Testing

Nothing typechecks the loader, so `unit/dev-loader.test.ts` _executes_ it against
stubbed `GM_*` APIs rather than reading it as text — the fake bundle it evals is
real JS, so the eval scope and the `GM_info` shadow are genuinely exercised. It
covers: placeholder rendering, `@connect` hosts, the version suffix staying
numerically equal to the build, subframe bail, long poll → fetch → eval, the
`GM_info` shadow pointing at the app, cache hit by rev, the client-id namespace,
error reporting, rev-not-advanced-on-throw, CSP bail, and the error filter.

Two harness notes, both of which caused a hang or a false pass while writing it:
park the second `/wait` instead of answering instantly (an instant answer spins
the pump loop through microtasks and the test never yields), and keep
placeholder tokens out of the template's prose (substitution is a plain string
replace and rewrites them mid-sentence).

`unit/userscript-loader.test.ts` is the equivalent for the older
`public/loader.user.js`.

## Operating notes

- **Disable the production Lianki script while the loader is enabled**, or both
  run on each page and each registers its own handlers.
- Reload the tab to pick up a change only if the long poll is not running; with
  `/wait` in place, a rebuild lands in open tabs on its own.

## Reference implementation

`scripts/dev-loader.user.js`. It is the file the server renders and ships, so it
is the only copy — deliberately not duplicated here, where it would drift.
