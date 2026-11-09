# Hosting the dev loader on lianki.com (design stub)

Tree: /ext/loader-host

State-tree node `/ext/loader-host`. Status: design only, nothing built.
Background: [dev-userscript-loader.md](dev-userscript-loader.md).

## Goal

The dev loader (`scripts/dev-loader.user.js`, "[dev] Lianki @dev") is today
**served by the dev server itself**, through the named tunnel behind
`dev.lianki.com` (the Linux dev box, or this Mac after
`dev-host-switch.sh`). When that box is down, `dev.lianki.com` answers 530
(error 1033) and the loader can neither be installed nor updated —
checked 2026-11-09: `https://dev.lianki.com/loader.user.js` → 530.

Serve the **loader file** from our own side instead —
`https://lianki.com/loader.user.js` from the `lianki` Worker's static assets —
so installing and updating never depend on a dev machine being up. Only the
**bundle** (the code that changes) keeps coming from a dev server.

## How it works after the change

```
lianki.com/loader.user.js   (static asset, Worker)  ── installed once, updates from here
        │  loader runs on a page
        ▼
dev.lianki.com /wait /bundle.js /error   (dev server via tunnel, as today)
```

- The hosted loader is the same template rendered **at build time** with
  fixed values: `__ORIGIN__` = `https://dev.lianki.com` (where the bundle
  comes from), `__APP_ORIGIN__` = `https://lianki.com`, `@connect
dev.lianki.com` and `lianki.com`, and
  `@downloadURL`/`@updateURL` = `https://lianki.com/loader.user.js`.
- `@name`/`@namespace` stay **exactly** `[dev] Lianki @dev` / `Violentmonkey
Scripts`, so a manager treats the new file as an update of the installed
  loader, not a second one (loader rules, "Header").
- `@version` must be **higher** than any version the dev server has served
  (`<pkg version>-dev.<rev>`): use the next package version with a plain
  number (`<next>` sorts above `<current>-dev.N`), bumped whenever the loader
  file changes.
- **Dev hot reload is unchanged**: the loader still long-polls
  `dev.lianki.com/wait` and fetches `/bundle.js` from whichever dev server
  holds the tunnel; when none does, it backs off quietly (as today on 530)
  and pages simply run without the dev build. `--origin` on the dev server
  keeps working for a quick tunnel, but then the loader must come from that
  server (the hosted one only knows `dev.lianki.com`).

## The old URL keeps working

Installed copies have `@updateURL https://dev.lianki.com/loader.user.js`
baked in; a manager only ever checks that URL. So:

1. **Step 1, no infra change**: the dev server, when it serves
   `/loader.user.js`, serves the hosted file's content (header pointing at
   lianki.com, higher `@version`). The next update check on each installed
   copy (while a dev server is up) moves it to lianki.com for good.
2. **Step 2, optional**: a Worker route `dev.lianki.com/loader.user.js` →
   `lianki` (308 to `https://lianki.com/loader.user.js`, or serve it), so
   copies that check while no dev server is up still find it. Everything
   else on `dev.lianki.com` keeps going to the tunnel. This is a Worker
   route on the existing zone, **not a DNS change**; the tunnel's CNAME is
   untouched.

Any change to DNS records (moving `dev.lianki.com`, a new hostname) needs
the **owner's typed confirmation in Slack** first. A route or a file under
the existing lianki.com Worker does not.

## The file on lianki.com today

`public/loader.user.js` already exists and is served by the Worker
(`Content-Type: text/javascript`, `cache-control: public, max-age=0,
must-revalidate`): it is the **older** vite loader ("Lianki Dev Loader",
namespace `lianki-dev`, fetches from `:3002` on every load). It is replaced
by the hosted dev loader. Its few installs (different name/namespace) will
not pick up the new file as an update; they are dev-only and are told to
reinstall once. `bun run dev:userscript` (vite) stays usable for local work
but no longer has a published loader.

## Serving details

- **Content-Type** `text/javascript; charset=utf-8` (what static assets send
  already); managers detect `.user.js` by the URL. Keep `Content-Disposition`
  absent or `inline` (`filename=` makes browsers download it).
- **Cache**: short — `Cache-Control: public, max-age=60` or `no-cache` (a
  `public/_headers` rule for `/loader.user.js`; `next.config.mjs` headers do
  not reach Worker static assets, as the live `text/javascript` shows).
- **Build**: `scripts/build-hosted-loader.ts` renders the template into
  `public/loader.user.js`; the pre-commit hook re-renders it when the
  template changes (like `lianki.meta.js`), and a unit test checks the
  rendered header (name, namespace, URLs, `@connect`, version order).

## Security and privacy

- The loader is code only, no secrets; it is public today on the tunnel too.
- It evals whatever `dev.lianki.com` serves, so **whoever holds the
  `dev.lianki.com` tunnel runs code in every browser with the loader
  installed**. Unchanged by this work, but now the install link is on the
  main site: the install page says it is for developers only, and it is not
  linked from user UI.
- No change to the production userscript (`lianki.user.js`), its `@version`
  or its update URL.

## Milestones

| #   | slice                                                                                                                                                                                                           | ETA |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| M1  | **First slice**: render the hosted loader into `public/loader.user.js` (lianki.com URLs, higher `@version`), `_headers` short cache, header unit test; dev server serves the same file at its `/loader.user.js` | 2H  |
| M2  | Pre-commit re-render on template change; docs (dev-userscript-loader.md install link) updated                                                                                                                   | 1H  |
| M3  | Optional Worker route `dev.lianki.com/loader.user.js` → lianki.com (owner OK by tap card; not DNS)                                                                                                              | 1H  |

ETAs include the local gate and ~10M pipeline.

## Open questions

1. Path: `lianki.com/loader.user.js` (replacing the old vite loader) or a
   new `lianki.com/dev/loader.user.js` to leave the old installs alone?
2. M3 at all? Step 1 already migrates every copy that checks while a dev
   server is up.
3. Should the hosted loader let the developer pick a bundle origin from the
   manager menu (dev.lianki.com / a quick tunnel / localhost), so one
   installed loader serves every setup?
