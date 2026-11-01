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
- sources: https on `*.ts.net` (tailscale serve) or a `*.lianki.com`
  subdomain (a tunnel). lianki.com itself is never allowed, and neither are
  credentials, a fragment, or more than 300 characters. `http://localhost`
  is allowed only in dev builds;
- `branch` and `sha` are required, so the banner always names the code.

**Stored server-side.** One D1 row, `live_view` (id 1,
`db/migrations/0022_live_view.sql`): the signed pointer, or NULL, and the
highest serial ever accepted. `POST /api/live-view {token}` takes a signed
"on" (stores it), "off" (clears it) or "status" (reads it). On and off must
carry a serial above every serial seen so far, or they get 409. So an old
pointer cannot be replayed, not even after "off". No session is involved:
the signature is the authority. The owner's session can also
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

One pointer at a time: a new `on` replaces the previous one. The widget
shows only where the chat does (debug mode on); islands show on every page
of the app shell.

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
  expiry), unsigned overrides refused on production, islands under live view.
- `scripts/qa/qa-api.mjs`: a non-owner gets 404 from GET and DELETE; an unsigned
  pointer gets 400; one signed by another key gets 401.
- `bun scripts/dev/live-view-qa.ts [--shots <dir>]`: silent Chromium on the real
  banner and switch (`scripts/dev/live-view-harness.tsx`), verifying with the
  browser's WebCrypto against a throwaway key. A good pointer shows the banner.
  A stranger's key and an expired pointer show none, and the switch says why.
  Shots at 390 px, light and dark.

## Rotate the key

`bun scripts/dev/live-view.ts keygen` refuses to overwrite. Move the old file
away, run keygen, add the printed key to `LIVE_VIEW_PUBLIC_KEYS`, deploy, and
then remove the old key.
