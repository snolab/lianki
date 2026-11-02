# Live view

The owner sees his dev machine's front-end code on the real site. The
address, the HTML, sign-in, cookies and the API all stay on lianki.com. Only
the JS of the swappable parts comes from the dev server, through the tailnet
or a Cloudflare tunnel, with hot reload:

- the Learning Partner widget ([dev-debug-widget.md](dev-debug-widget.md));
- the hot islands ([dev-hot-islands.md](dev-hot-islands.md)).

Owner's approval: Slack, 2026-11-01 11:41 JST ("要做").

## Turn it on

On the Mac, with the dev servers running (they print the line to use):

```bash
bun scripts/dev/debug-widget-server.ts --port 5180 --tailnet /lianki-widget
bun scripts/dev/islands-server.ts --port 5181 --tailnet /lianki-islands
bun scripts/dev/live-view.ts on                       # both, if they answer; 12 h
bun scripts/dev/live-view.ts on --widget /lianki-widget-drag   # one, at another serve path
bun scripts/dev/live-view.ts status
bun scripts/dev/live-view.ts off                      # stop
```

On each device: account menu → **Live view ⇄ Normal**. It is a per-device
switch (cookie `lk_live_view`), so the phone can be live while the laptop is
not. While a live pointer is loaded, a banner across the top says
**Live view · <branch>@<sha>**, with a **Normal** button. With the switch on
and no pointer, the menu says "Waiting for the dev machine", and the page is
the normal one. A new pointer takes effect on the next page load; after that,
saves reach the open page by hot reload, with no reload.

## Design

**A signed pointer.** `scripts/dev/live-view.ts` signs, with an Ed25519 key
that exists only on the Mac (`~/.config/lianki/live-view-key.json`, 0600):

```
{aud:"lianki-live-view", op:"on", serial, iat, exp, widget?, islands?, branch, sha}
```

as `<payload>.<signature>` (base64url, the form of the STT tickets). The STT
tickets go the other way: lianki.com signs and the Mac verifies
(lib/stt-ticket.ts). Here the Mac signs, and lianki.com and the page verify
with the **public** key, committed in `lib/live-view/keys.ts`. It is in the
source, the same in the Worker and the browser bundle, and reviewed like
code. It is not a Worker var and not a secret.

Rules (`lib/live-view/rules.ts`, shared by the route, the page and the script):

- an "on" lives at most 12 h; "off" and "status" at most 5 min; `iat` may be
  at most 60 s in the future;
- sources: only the exact origins in `lib/live-view/origins.ts` (scheme,
  host and port), over https. Today that is the owner's Mac on the tailnet,
  `https://taku.onca-tint.ts.net`. Any other `*.ts.net` host, another port,
  or a tunnel not on the list is refused, signed or not. Credentials, a
  fragment, or more than 300 characters are refused too. `http://localhost`
  is allowed only in dev builds;
- `branch` and `sha` are required, so the banner always names the code.

**Stored server-side.** One D1 row, `live_view` (id 1,
`db/migrations/0022_live_view.sql`): the signed pointer, or NULL, and the
highest serial ever accepted. `POST /api/live-view {token}` takes a signed
"on" (stores it), "off" (clears it) or "status" (reads it). On and off must
carry a serial above every serial seen so far, or they get 409. So an old
pointer cannot be replayed, not even after "off". No session is involved:
the signature is the authority. Because the POST is anonymous, it costs
little: a Content-Length over 4 KB is 413 at once, the body is read as a
stream and cut off at 4 KB (413), and each IP gets 30 POSTs per 10 minutes
(429 with Retry-After; the `auth_throttle` counters) before any signature
is checked. The owner's session can also
`DELETE /api/live-view` (stop). That only reduces what loads, so the session
alone is enough. `GET` returns the current pointer to the owner's session.
Both answer 404 to anyone else. The route is not under `/api/dev`, because
the Mac's POST has no session, and Cloudflare Access on `/api/dev` would stop it.

**Checked on the server, then again on the page.** For the owner only
(`isOwner`), the app layout reads the switch cookie. Only while it is on, it
reads the row and verifies it (lib/live-view/shell.server.ts). Everyone else
gets no strings, no switch and no pointer. The page (`LiveViewBoot`) verifies
the pointer again with WebCrypto and the bundled keys. Only then does it
publish the sources in `lib/live-view/client.ts`, which the widget host
(DebugEval → `DebugChatHost src=`) and the islands (`useIslands`) read. One
local timer turns it off at `exp`.

**The old unsigned overrides.** On production, `lk:agent-widget-src`,
`lk:debug-widget-src` and `lk:slots-src` are ignored. The chat's menu and
`islands.status` say so. They still work under `next dev` (the whole-page dev
server) and on pages served from localhost (`unsignedOverridesAllowed`), so
the harness, `debug-chat-bar-qa.mjs`, `wake-word-qa.mjs` and
`tests/hot-islands.spec.ts` are unchanged.

**Islands under live view** need no eval pairing: the verified pointer is
the permission, until its expiry (`islandStore.setLive`). The code-run grant
still works as before where unsigned overrides are allowed.

## What changed for previews

Before, an agent set `lk:agent-widget-src` or `lk:slots-src` on the owner's
phone through eval, and that was enough on lianki.com. Now, on lianki.com:

1. the agent runs `bun scripts/dev/live-view.ts on --widget /<its serve path>`
   (or `--islands`), from the checkout it serves, so the banner names its
   branch;
2. the owner turns on **Live view** once on that device. It stays on until he
   turns it off, and later pointers need no tap.

**The compact-mode preview (#401)**, hot-loaded today through
`lk:agent-widget-src` from `/lianki-widget-compact`, keeps working after
this deploys with `bun scripts/dev/live-view.ts on --widget /lianki-widget-compact`
(run in the #401 checkout, so the banner names it), plus the Live view
switch on the phone.

One pointer at a time: a new `on` replaces the previous one. The widget
shows only where the chat does (debug mode on); islands show on every page
of the app shell.

## What is trusted

A signed pointer hands code authority for up to 12 h to whatever is served
at its URLs. So:

- **Only the owner's own origins** (origins.ts, a reviewed list). Today that is
  his Mac's `tailscale serve`, which only his tailnet can reach. Adding a
  tunnel host means adding its exact origin there.
- **Pinned import.** The page never `import()`s the URL directly. It fetches
  the module with `redirect: "error"` and no cookies, and checks that the
  response came from that same origin. It then imports exactly those bytes from
  a `blob:` URL (`importPinned` in packages/debug-chat/src/debug-widget.ts,
  used by the widget host and the islands loader). A redirect, another origin,
  or a second request serving other code cannot get in. The modules are
  single files: they import nothing themselves.
- **Bundles must stay single-file.** Inside a `blob:` module a relative
  import (`./dep.js`, `/dep.js`) cannot resolve, and an absolute one would
  load code that was never pinned. So `importPinned` scans the fetched text
  and refuses any static `import`, `export … from` or `import("literal")`,
  with the error "live modules must be single-file bundles" (`moduleImports`;
  a unit test checks today's widget and islands bundles have none). A
  computed `import(expr)` cannot be judged statically and is allowed: the
  widget uses one for the wake-word worker's own blob. Splitting a bundle
  needs a dependency loader that pins and validates every chunk the same
  way first.
- **The gates cannot be planted or flipped.** The source the page may load
  lives in a module-local store (`lib/live-view/client.ts`), never on
  `globalThis`. The one global that copies of the chat package share (the
  host's decision, which TreeFragment follows) is a getter defined once,
  non-configurable and with no setter (`hostGate`). Later code cannot assign
  it or redefine it. If a script defined it first and it cannot be replaced,
  the host loads nothing (fail closed). A script that runs before
  Lianki's own on lianki.com could do anything as the user anyway; this
  stops code loaded later, such as a hot island, from widening the source.
- **What remains trusted:** the dev servers on the Mac and whoever can write
  their working trees (the agents), `tailscale serve` on the Mac, the tailnet
  itself, and the Mac's private key file. The hot reload's SSE stream only
  says *when* to re-import, never *what*. The re-import goes through the same
  pinned path.

## HMR

Unchanged: the dev servers' SSE (`reload`, `slot-reload`) and the page's
re-import. Measured with `bun scripts/dev/live-view-hmr.ts [--runs 5] [--tailnet]`
on the Mac (Chromium on the same machine, 2026-11-01):

| Path                                            | Save → visible (median, n=5) |
| ----------------------------------------------- | ---------------------------- |
| widget, localhost                               | 167 ms (158–172)             |
| widget, through `tailscale serve`               | 171 ms (168–180)             |
| islands, save → `slot-reload` sent, no tsgo     | 136 ms                       |
| islands, save → `slot-reload` sent, with tsgo   | 418 ms                       |

The islands' figure stops at the event. The page's import and swap after it
are the same work as the widget's. A phone adds one network round trip for
the event and one for the module.

## Tests

- `unit/live-view.test.ts`: signatures (good, expired, wrong key, tampered,
  rotation), lifetimes, sources, replay and older serials (also after off),
  the owner's stop, the owner-only shell, the page store (refusal reasons,
  expiry, a stop or a newer start during a verify), unsigned overrides refused on
  production, islands under live view, exact origins, the pinned import
  (redirects, other origins), the body cap and the per-IP limit.
- `scripts/qa/qa-api.mjs`: a non-owner gets 404 from GET and DELETE; a malformed
  token gets 400; one signed by another key gets 401.
- `bun scripts/dev/live-view-qa.ts [--shots <dir>]`: silent Chromium on the real
  banner and switch (`scripts/dev/live-view-harness.tsx`), verifying with the
  browser's WebCrypto against a throwaway key. A good pointer shows the banner.
  A stranger's key and an expired pointer show none, and the switch says why.
  Shots at 390 px, light and dark.

## Rotate the key

`bun scripts/dev/live-view.ts keygen` refuses to overwrite. Move the old file
away, run keygen, add the printed key to `LIVE_VIEW_PUBLIC_KEYS`, deploy, and
then remove the old key.
