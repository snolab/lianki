# Hot-loading the debug chat widget

See a change to the debug chat box (`packages/debug-chat/src/DebugChat.tsx`) live on
the owner's phone, seconds after saving and without merge or deploy. The page
stays on lianki.com, so the debug socket, the chat history and the owner's
data all keep working. Only the widget module comes from your machine.

## Naming

**User-facing name: Learning Partner / 学习伙伴; internal: debug.** Users never
see the word "debug": the menu badge, the /words badge, toasts, the chat's
aria-labels and placeholders all say the localized name, from
`app/components/learning-partner.content.ts` (key `learning-partner`). English
reads one constant, `AGENT_NAME_EN` in `packages/debug-chat/src/wire.ts`; the
widget takes its strings as the `strings` prop (`ChatStrings`, English
defaults in `wire.ts`), so the package still imports nothing from the app.

| Locale | Name                       | Locale | Name                |
| ------ | -------------------------- | ------ | ------------------- |
| en     | Learning Partner           | ru     | Напарник по учёбе   |
| zh     | 学习伙伴 (zh-TW 學習夥伴)  | ar     | رفيق الدراسة        |
| ja     | 学習パートナー             | hi     | पढ़ाई का साथी       |
| ko     | 학습 파트너                | bn     | পড়াশোনার সাথী      |
| fr     | Partenaire d'apprentissage | ur     | پڑھائی کا ساتھی     |
| de     | Lernpartner                | id     | Teman Belajar       |
| es     | Compañero de aprendizaje   | sw     | Mwenzi wa Kujifunza |
| pt     | Parceiro de aprendizagem   | mr     | अभ्यास सोबती        |

The app ships one Chinese locale (`zh`, Simplified); 學習夥伴 is the agreed
name for when zh-TW is added.

Everything internal keeps "debug": the package, files, APIs, `/api/debug/*`,
`data-debug-*` / `data-testid="debug-*"` hooks, and the owner-only dev pages.
Storage moves to `lk:agent*` gradually (`packages/debug-chat/src/storage-keys.ts`):
reads try `lk:agent*` then `lk:debug*`, writes go to both, and a one-time
migration (marker `lk:agent-migrated`) copies `lk:debug*` to `lk:agent*`. Drop
the `lk:debug*` writes one release later. `?agent=1` / `?agent=0` work as
aliases of `?debug=1` / `?debug=0` (`?agent=` wins when both are given).

The widget lives in its own workspace package, `packages/debug-chat`
(`@lianki/debug-chat`), which imports nothing from the app, so it can move to
its own repo as is. Lianki passes what it needs as `DebugChatProps`; the wire
types and the UI helpers are in `src/wire.ts`, which `lib/dev-eval.ts`
re-exports for the hub and the sender.

| File (`packages/debug-chat/src/` unless a path is given) | Role                                                     |
| -------------------------------------------------------- | -------------------------------------------------------- |
| `debug-chat-widget.ts`                                   | the widget entry: `DebugChat` and `WIDGET_API`           |
| `DebugChat.tsx`                                          | the chat box: log, the bar (controls + input), menu      |
| `float-lines.ts`                                         | minimized: floating lines, their dwell and timers        |
| `compact-view.ts`                                        | compact mode: last message only, when to fold again      |
| `full-screen.ts`                                         | full screen: who gets it, the box above the keyboard     |
| `log-surface.ts`                                         | the log's display, shared by the log and the state tree  |
| `typing-glass.ts`                                        | the chat box's own frost while typing                    |
| `Frontier.tsx`, `frontier-view.ts`                       | minimized: the ✓ ▶ › frontier lines and their rules      |
| `DebugChatHost.tsx`                                      | the page's loader: import, re-import on reload, fallback |
| `DebugPairModal.tsx`                                     | the pairing modal                                        |
| `MicButton.tsx`, `mic.ts`                                | the mic: VAD, STT client, dictation rules                |
| `latency.ts`                                             | voice → reply timing per line (monitoring.md)            |
| `debug-widget.ts`                                        | shared rules: allowed URLs, cache-busting, module checks |
| `debug-chat-tabs.ts`, `tap-gesture.ts`                   | one voice per device; taps and drags                     |
| `wire.ts`, `icons.tsx`, `LiagentMark.tsx`                | wire types and helpers; icons; the liagent mark          |
| `Avatar.tsx`, `avatar-rules.ts`                          | the log's avatars: the component; its pure rules         |
| `rich-text.ts`, `RichText.tsx`, `chat-links.ts`          | markdown, the HTML subset, links; trust tiers            |
| `node-path.ts`                                           | state-tree node paths: validation, routing, rendering    |
| `scripts/dev/debug-widget-build.ts`                      | Bun.build with React from the page, plus Tailwind CSS    |
| `scripts/dev/debug-widget-server.ts`                     | serve, watch, SSE `reload`, tailnet or tunnel            |
| `scripts/dev/debug-widget-harness.tsx`                   | `/harness`: a local host page for tests                  |

## Use it

```bash
# Default: over the tailnet (tailscale serve, never funnel). Prints the URL.
bun scripts/dev/debug-widget-server.ts --port 5180 --tailnet /lianki-widget
#   → https://my-mac.example-tailnet.ts.net/lianki-widget/debug-chat.js

# Localhost only (tests, desktop Chrome on this Mac):
bun scripts/dev/debug-widget-server.ts --port 5180 --no-tunnel

# Over a Cloudflare named tunnel, once one exists (below):
bun scripts/dev/debug-widget-server.ts --port 5180 --tunnel lianki-dev-mac --origin https://dev-mac.lianki.com
```

Pages on other origins (e.g. the whole-page dev server, docs/dev-whole-page.md) are
answered cross-origin only when listed exactly in `LIANKI_DEV_ORIGINS` (comma-separated
https origins, no wildcards), for both this server and `scripts/dev/islands-server.ts`:
`LIANKI_DEV_ORIGINS=https://<mac>.<tailnet>.ts.net:8443 bun scripts/dev/debug-widget-server.ts …`.

**On lianki.com, use live view** ([live-view.md](live-view.md)):
`bun scripts/dev/live-view.ts on --widget /lianki-widget`, then "Live view" in
the account menu. Since 2026-11-01 the unsigned key below is ignored on
production; it still works on localhost and in dev builds (the harness, the
whole-page dev server). There, run this once in the console, or with
`bun scripts/dev/eval.ts`:

```js
localStorage.setItem(
  "lk:debug-widget-src",
  "https://my-mac.example-tailnet.ts.net/lianki-widget/debug-chat.js",
);
location.reload();
// back to the built-in chat:
localStorage.removeItem("lk:debug-widget-src");
location.reload();
```

Save `DebugChat.tsx` (or anything it imports): the server rebuilds, and if
the output changed it sends `reload`. The page re-imports
`debug-chat.js?v=<rev>` and re-mounts the widget. The messages, the socket
and the pairings live in DebugEval and are passed in as props. Position,
open/closed and read-aloud are in localStorage. A re-mount loses none of it,
only a half-typed draft. The pill's menu (its ⋯) says
`dev widget: <host> · <rev>`, or why it fell back.

## How it works

**One React, shared by rendering in the page's own tree.** The widget is
built as ESM with every `react`, `react-dom` and `react/jsx-runtime` import
rewritten by a Bun plugin into a stub that reads `globalThis.__lkReact`. The
page sets that, with its own React, only on the owner's debug pages and just
before importing. The module exports the `DebugChat` component itself, and the
page renders it as `<Remote {...props}/>` inside its own tree, behind an
error boundary. So there is no second React copy, no second root, and context
and events work as usual. The cost is that the widget must stay a React
component with the props `DebugChatProps`. `WIDGET_API` (in
`packages/debug-chat/src/debug-widget.ts`) is bumped when that contract changes, and a page that
expects another version falls back.

**Who honours it.** It applies only on the owner's pages: a page knows it is
the owner's when the hub sends `state` with no `friend-status` first, so
friends' pages ignore the key. Only `https:` URLs are accepted, plus `http:`
on localhost / 127.0.0.1 / [::1]. Any failure (a bad URL, the import, a
module without `DebugChat` or with another `WIDGET_API`, or a render error)
falls back to the bundled chat, with a one-line note in its menu.

**Event-driven.** The page holds one `EventSource` on `<dir>/events`. The
server sends `hello <rev>` on connect and `reload <rev>` after a rebuild that
changed the output; nothing polls. If the stream drops (a proxy's idle
timeout), the browser re-opens it, and a `hello` with a newer rev re-imports.

**CSS.** Production CSS holds only the classes the deployed app uses, so the
server also compiles the Tailwind utilities that the widget's sources use,
with the app's `@theme` from `app/globals.css`, and appends them to the
module as `css`. The page puts them in a `<style>`, inside the same
`utilities` layer. New utility classes therefore work live. New custom CSS in
`globals.css` (like `.lk-halo`) does not; that needs a deploy.

**CORS.** `debug-chat.js` and `/events` answer `Access-Control-Allow-Origin`
for https://lianki.com and localhost origins, plus
`Access-Control-Allow-Private-Network: true`.

## Tailnet (the default)

`--tailnet /lianki-widget` runs
`tailscale serve --bg --set-path /lianki-widget http://127.0.0.1:<port>` and
removes it with `tailscale serve --set-path /lianki-widget off` on exit
(SIGINT/SIGTERM). It uses serve, never funnel, so the URL resolves only on the
tailnet, and the phone must be on Tailscale. serve strips the path prefix, so
the server needs no base path, and the SSE stream passes through it.

**Chrome asks once.** A tailnet address (100.x) is "local" to Chrome's Local
Network Access, so in Chrome (desktop or Android) lianki.com shows a one-time
prompt to access devices on the local network. Allow it, or the import fails
and the chat falls back with the note `Failed to fetch dynamically imported
module`. Safari on iOS has no such gate. In Playwright, grant it with
`context.grantPermissions(["local-network-access"], {origin: "https://lianki.com"})`.

## Cloudflare tunnel (optional)

`cloudflared` is not installed on the Mac yet. Once it is, create the tunnel
and its DNS route once:

```bash
cloudflared tunnel login                       # browser: pick the lianki.com zone
cloudflared tunnel create lianki-dev-mac
cloudflared tunnel route dns lianki-dev-mac dev-mac.lianki.com
```

Then `--tunnel lianki-dev-mac --origin https://dev-mac.lianki.com` makes the
server run `cloudflared tunnel run --url http://localhost:<port>
lianki-dev-mac`, and exit if that dies. `--origin` is required because a named
tunnel's hostname lives in its DNS route. The same notes as for the
userscript loader apply ([dev-userscript-loader.md](dev-userscript-loader.md)):
the server binds `::`, and if the tunnel is remotely managed, its port must
match. The URL is public, but it serves only the widget code.

## On every site (the userscript)

Owner, 2026-11-01: the Learning Partner renders on every site through the
userscript, without touching the site's CSS or being touched by it.

**Who gets it.** Off for everyone by default. It runs only when (1) debug
mode is on for that browser on lianki.com (`lk:agent`/`lk:debug` = "1"; the
userscript mirrors it into its own storage as `lianki_partner_on` when he
visits lianki.com), (2) `POST /api/debug/partner-ticket` answers with a
ticket, which it does for the owner only (404 for anyone else), and (3) it is
the top window and not a site he hid it on (the note's ×, `lianki_partner_hidden`).

**Files.** `src/partner.ts` (the userscript's side: switch, ticket, fetch,
mount), `packages/debug-chat/src/embed/` (`isolation.ts` the shadow host,
styles and key guard; `guard.ts` when it may run and why not;
`partner-client.ts` the socket; `partner-embed.tsx` the entry),
`scripts/build-partner-embed.ts` (the build), `scripts/qa/qa-partner-embed.ts`
(`bun run qa:partner`, silent, against a hostile fixture page).

**Isolation.** One plain `<div>` on `<html>` (never a custom tag: a page could predefine one and take the root through attachInternals), its style set
inline with `!important` through the CSSOM (beats `* { all: unset
!important }`; CSP does not govern the CSSOM), and a **closed** shadow root.
Inside: `:host { all: initial }`, a reset in `@layer base` (under Tailwind's
utilities), the font stack `system-ui` first (a generic family no page
`@font-face` can redefine), and every `rem` of the widget's CSS rewritten to
px, so the page's `html { font-size }` changes nothing. All CSS goes into the
root as constructed sheets (`adoptedStyleSheets`, which CSP `style-src` does
not block), else a `<style>` inside the root. `:root` becomes `:host`;
`@font-face`, `@property` and `@import` are dropped, so nothing leaks out.

**Keys.** Keyboard events are stopped at the shadow root in the bubble phase,
after the widget's own handlers and before the page's document/window
listeners. Only events from inside the root pass there, so a key typed on the
page is never touched. Nothing listens on document or window for keys; the
tree's Escape (a window listener) acts only while focus is inside the chat
(`embedded`). Limit: a page listener in the capture phase still sees the key
first (as a key on a custom element).

**What the widget may reach.** The bundle is one function; inside it,
`localStorage` is the userscript's GM storage (`lianki_partner_ls:*`),
`sessionStorage` is memory, and `fetch`, `EventSource`, `WebSocket`,
`XMLHttpRequest` throw, and `navigator` has no `mediaDevices`/`sendBeacon`.
`window.X`/`globalThis.X`/`self.X` of those names are rewritten at build
time. So nothing lands in the site's storage and no request goes to the site.
`embedded` also drops the mic and voice-clip recording.

**Auth.** The userscript fetches a 60 s single-use ticket with
GM_xmlhttpRequest (its lianki.com session, or `lk:token` only when that
token holds both `chat:read` and `chat:write`; header `x-lianki-userscript: 1`),
signed with the STT ticket key under another
audience (`lianki-partner`, `lib/stt-ticket.ts`). It is offered in
`Sec-WebSocket-Protocol: lianki-partner, <ticket>`, never in the URL.
The ticket names no account (it always opens the owner's thread), so
the route (`lib/partner-ticket-auth.ts`) gives one to the owner only: a
`study` token (cards and settings) or a token of another account gets 404,
and a token that does not qualify leaves the session to decide
(`unit/partner-ticket-route.test.ts`). No other `/api/debug/*` or
`/api/dev*` route takes an API token at all (same test).
lianki-push (`workers/push/src/auth.ts` `partnerTicket`) verifies it with
`PARTNER_TICKET_PUB` and the hub burns its jti (`pjti:*`) before accepting.
The split is strict: from https://lianki.com only the cookie counts; from any
other origin only a ticket. A ticket socket is the owner's thread, **chat
only**: the hub sends it no eval, lists it in no page list, never counts it
for a grant, and drops everything it sends except `chat` and `page`
(`unit/partner-ticket-hub.test.ts`). Its `state`, on connect and in every
broadcast, is `{type, pending: null, sessions: [], listeners}` only: no
pairing, session, grant, page label or id, node or `self` (`pageState` in
`workers/push/src/debug.ts`). The label is host + path, never the query.

The owner's own box (`box:chat`, [box-oauth.md](box-oauth.md), "Chat on the
owner's box") uses the same subprotocol with a ticket of its own audience
(`lianki-box-chat`), good only from the exact box origin it names. Such a socket
is chat-only too, may also send voice amends and ask-card taps, and the hub asks
the main Worker before each line it takes from it.

With `box:eval` as well (box-oauth.md, "Code on the owner's box"), that box's
socket is an owner page instead: listed, labelled `box <path>`, sent the whole
state, reached by eval (`eval.ts --target box`), able to answer a pairing with
the owner's tap on that page, and its page errors go to the agents. It never
records clips and carries no session, so a grant approved there is never
renewed (8 hours, then a tap). The hub asks the main Worker (`boxEval`) at
connect, before each eval it sends there and before each pairing answer, result
or page error it takes; gone, the page drops back to chat-only.

**The frame: private typing (owner, 2026-11-01).** A shadow widget cannot
keep keys private: the host page's capture listeners on document or window
see every `KeyboardEvent.key` (and composed `input` events) before any
guard. So the chat runs in a **lianki.com frame**, `/embed/partner`
(`app/embed/partner/`), the one route any site may frame
(`frame-ancestors *`, next.config.mjs). Keys typed there go to the frame's
own document; the host page never sees them.

- **Shell** (`src/partner-frame.ts`, trusted userscript code, plain DOM): a
  plain div with a closed root holding a grip and the iframe. It keeps the
  position (drag the grip; kept in `lianki_partner_pos`), minimize
  (double-click the grip) and the iframe's size (the frame reports its
  chat's box, so the rest of the page keeps its clicks).
- **Handshake** (`embed/frame-protocol.ts`, `embed/frame-guest.ts`): the frame
  posts `{lk:"partner-frame-up"}` to its parent (nothing secret); the shell
  checks it came from its own iframe on the app origin and answers with
  `{lk:"partner-hello", label}` and a `MessagePort`, to that origin only; the
  frame says `ready` on the port. No `up` within 800 ms of the frame's load
  (10 s overall), or a CSP report refusing the frame (`frame-src`,
  `child-src`), means blocked. The handshake decides, not a site list: he
  runs an extension that blocks frames on some sites.
- **Tickets**: the frame holds no session (third-party: no cookie). It asks
  for a ticket on the port; the shell fetches one with GM_xmlhttpRequest and
  writes it into its own port only. The frame's socket comes from
  https://lianki.com with the partner subprotocol, so lianki-push judges it
  on the ticket alone (`offersPartner`), chat only, as before. A hostile
  parent that gets its hello in first can only keep the frame from working;
  it never receives a ticket or typed text.
- **No owner boots in the frame.** `/embed/partner` is framable by any site,
  so the root layout mounts none of the owner's page boots there
  (`OwnerBoots`: DebugEval with its cookie socket, pairing / Allow UI, eval
  and hot islands; the service worker; the version notice). middleware.ts
  sets `x-lianki-partner-frame` from the path alone (a request can neither
  set nor clear it), and app/layout.tsx skips `OwnerBoots` on it. It does
  not rely on third-party cookie blocking.
- **Defence in depth.** DebugEval never connects from a frame whose
  ancestors are not its own origin (`lib/frame-context.ts`), and says where
  it sits (`&frame=top|same|foreign`). The hub treats a `frame=foreign` page
  as chat-only, like a ticket socket (no pairing, no Allow, no eval, minimal
  state), and refuses a pairing when no real owner page is open.
  Tests: `unit/partner-frame-route.test.ts`, `unit/partner-ticket-hub.test.ts`;
  the real route in a frame: `scripts/qa/qa-partner-frame-route.ts` (in qa:all).
- **Blocked → read-only**: the shadow widget (`mountPartner({readOnly:
true})`) shows the replies, and in place of the input a note ("This site
  blocks private typing…") with a link to reply on lianki.com. No key is
  asked for on such a site.
- **ScriptCat's network rules** ("移除 CSP、改写请求头"): an options-page
  feature only (Tools → Network rules), with actions to remove or set whole
  response headers; no metadata key or GM API lets a script add one, and a
  DNR rule cannot add one source to one directive (a second CSP header only
  narrows). So nothing is added for it; the handshake still decides.

**Where it must not run.** `guard.ts` decides, and a small glass note says
why instead of the chat (strings `EmbedStrings` in `ui-strings.ts`, by the
browser's language):

| Blocker     | When                                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| `pageRealm` | the manager runs the script in the page's own JS realm (the site could patch WebSocket, read memory) |
| `connect`   | a CSP `connect-src` report names the hub, or the socket constructor throws                           |
| `styles`    | constructed sheets unsupported and the `<style>` fallback blocked                                    |
| `script`    | a CSP report on eval/inline script or Trusted Types                                                  |
| `load`      | the widget threw while rendering                                                                     |

Isolation is decided fail-closed from the manager's own `GM_info` only (a
binding in our scope, never a page global; `window.Object` and the like can
be made to answer anything), read as own properties through syntax alone (a
null-prototype spread, strict string equality: no built-in the page could
replace). A page word refuses (`injectInto: "page"`, a declared
`@inject-into page`, `sandboxMode` "raw" or "js"); then it needs a positive
word (`injectInto: "content"`, or `sandboxMode: "dom"`); anything else,
including an unknown manager, counts as the page's realm. So the chat runs
only where the manager says it injected into the content/DOM world; the
default page modes of Tampermonkey, Violentmonkey and ScriptCat get the note.
In the page's realm `startPartner` stops
before anything privileged: no ticket is asked for, nothing is downloaded or
evaluated, no callback is handed out (the page could replace `eval` and
capture them). The `pageRealm` note there is drawn by the userscript's own
code (`pageRealmNote` in `src/partner.ts`: plain DOM, CSSOM styles, a closed
root on a div). Never a broken page: every step catches.

**The host is a plain div**, never a custom tag: a page could define that tag
first with a class calling `attachInternals()`, and `ElementInternals.shadowRoot`
would hand it our closed root (`qa:partner` checks it, with a control).

**Serving.** Production: `public/partner-embed.js`, built in
`deploy-worker.yml` (gitignored). Dev: the userscript dev server
(`bun run dev:loader`) serves `/partner-embed.js` and rebuilds on any change
in `packages/debug-chat/src`, so a widget edit reaches every attached tab.

**Deploy needs.** `PARTNER_TICKET_PUB` on lianki-push
(`wrangler secret put PARTNER_TICKET_PUB -c workers/push/wrangler.jsonc <
~/.config/lianki-stt/ticket.pub`) and `STT_TICKET_KEY` on the main Worker
(already set for the STT). Without them, tickets are refused and the
partner stays off.

## Avatars

Each log line starts with an 18px round avatar instead of a name. Who it
shows:

| Line                         | Avatar                                                |
| ---------------------------- | ----------------------------------------------------- |
| the agent's                  | the `agentAvatar` prop: Lianki passes `/icon-192.png` |
| the viewer's own             | the `viewer` prop, then the line's `sender`           |
| anyone else's (owner/friend) | the host's `avatarFor(m)`, then the line's `sender`   |

Each person's pictures are tried in order: the app's own avatar (Lianki
keeps none, so this step is empty), then the sign-in provider's image
(better-auth's `user.image`; Google gives a letter avatar even to accounts
without a photo). A picture that fails to load (`onError`) falls through to
the next, and after the last to a generated one: the name's initial on
`oklch(0.7 0.12 <hue>)`, the hue from a hash of the person's id (the hub's
hashed user id, never the email), the letter near-black or white, whichever
contrasts more (at least 4.5:1 on every hue; `unit/chat-avatars.test.ts`).

Pictures load with `referrerPolicy="no-referrer"` (Google's need it) and
`loading="lazy"`, at a fixed size in inline styles, so a late load shifts
nothing and the avatar keeps its shape on a page without the widget's CSS.
The visible name is gone; an `sr-only` span keeps it ("you: …", "Ada: …"),
so screen readers still hear who said what. The avatar itself has `alt` /
`aria-label` set to the name and is `aria-hidden` in the log, so the name is
read once; its `title` is the hover tooltip.

**Where `sender` comes from.** `/api/debug/identity` also answers `name` and
`image`; lianki-push passes them to the hub as `x-debug-name`
(percent-encoded) and `x-debug-image` (https only, at most 300 characters,
since the page's socket attachment must stay under 2 KB). The hub keeps a
`Sender` per page (`{id: hashId(userId), name, avatars}`), sends it to that
page on connect as `{type:"me", sender}` (DebugEval passes it as `viewer`),
and puts it on every line the page sends. Both fields are optional: older
lines and pages, and an older main Worker, get the initial.

## Node paths

Messages are addressed to **state-tree nodes**, and a node's **assignee** (an
agent or a human) receives them. A node path is route-like: `/words/prefetch`,
shown in the chat as `/words › prefetch`. The root, `/`, is the main thread,
where everything went before node paths. So a sub-agent can post in the same
chat window as the main agent, and every line says which node it came from.
The pure rules are in `packages/debug-chat/src/node-path.ts` (re-exported by
`wire.ts` and `lib/dev-eval.ts`), tested in `unit/node-path.test.ts`; the hub's
routing is tested in `unit/debug-hub.test.ts`, "DebugHub node paths".

**Fields.** Every field is optional, and lines and listeners without them
work as before.

| Field              | On                          | Meaning                                                       |
| ------------------ | --------------------------- | ------------------------------------------------------------- |
| `taskPath`         | an agent's line             | the sender's node, e.g. `/words/prefetch`                     |
| `agentId`          | an agent's line             | the node's assignee, e.g. `prefetcher`                        |
| `to`               | an owner's or agent's line  | the node it is addressed to; absent or `/` = the main thread  |
| `observed`         | the `chat` envelope         | delivered to an ancestor of `to`, not to `to` itself          |
| `?node=`/`?agent=` | the controller's socket URL | the node a listener subscribes at, and its assignee           |
| `nodes`            | the pages' `state`          | the listeners' nodes (never `/`), for the input's completions |

The hub validates every path the same way: it trims it, splits it on `/` or
`›`, accepts only the characters `A–Z a–z 0–9 . _ ~ -` in each segment, refuses
`.` and `..`, and caps the result at 80 characters. A path that is too long is
refused, never truncated, since a cut path would name another node. An
`agentId` is trimmed and cut to 40 characters of letters, digits, `._@:+-` and
spaces. A bad `taskPath` or node `to` from an agent is an error. A bad `to`
from a page is dropped, and that line goes to the main thread.

**Routing.** A line addressed to node P (the hub's `post`) is delivered:

- to the listeners at P exactly;
- to the listeners at an ancestor of P, marked `observed: true`. The main
  listener, at `/`, is an ancestor of every node, so it sees everything and
  nothing is lost;
- to no listener at a sibling or a descendant of P.

A listener from before node paths has no `?node=`, so it counts as `/`. A
main-thread line (no `to`) reaches only the `/` listeners, as before. A node
listener's history on connect holds only the lines routed to it. The owner's
pages get every line of the thread, whatever its node.

**Agent → agent.** An agent's `say` with a `to` that starts with `/`
addresses that node; any other `to` is still a friend's thread. The
sender's node is its line's `taskPath`, else its socket's `?node=`. The
`taskPath` must lie within the socket's node, if the socket has one. The send
is allowed when one of these holds:

1. P is inside the sender's own subtree;
2. P is the sender's parent or another ancestor, including `/`: replying
   upward is always allowed;
3. a live **node grant** covers the sender's node and P.

Otherwise the hub answers
`{type:"error", reason:"out of scope: needs a grant from /words"}`, naming the
common ancestor. A node grant, `{type:"grant", from, to, ms?}`, lets every
sender within `from` address every node within `to`, for 8 hours by default
and 30 days at most. `{type:"ungrant", from, to}` takes it back. Only a
listener whose node holds both `from` and `to` may grant (the main listener
always may), and the hub stores it as `ngrant:<from>><to>`. The live-roadmap
hub's HMAC-scoped tokens (`lib/progress-token.ts`) are not on `main` yet, so
there is no `--grant <token>`; the main listener's approval is the only way
for now.

**CLI** (`scripts/dev/eval.ts`; `scripts/dev/node-args.ts` holds its pure parts):

```bash
# A sub-agent sets its place once:
export LIANKI_TASK_PATH=/words/prefetch LIANKI_AGENT=prefetcher
bun scripts/dev/eval.ts chat                      # hears /words/prefetch (and below, observed)
bun scripts/dev/eval.ts say "warming the cache"   # shown as "/words › prefetch" under the avatar
bun scripts/dev/eval.ts say --to /words "done"    # upward: always allowed
# Flags win over the env vars:
bun scripts/dev/eval.ts --task-path /words --agent words say --to /words/prefetch "do X"
# From the main listener: let one sibling address another
bun scripts/dev/eval.ts grant --from /words/prefetch --to /words/audio [--hours 8]
bun scripts/dev/eval.ts ungrant --from /words/prefetch --to /words/audio
```

`chat` prints each line with its `to`, `taskPath`, `agentId` and, when
observed, `"observed": true`. It skips its own lines and the agents' replies
to the main thread, as before, but prints agent lines addressed to a node.

**In the widget.**

- **An agent's line** shows the agent's avatar, then a small muted subtitle
  with its node (`/words › prefetch`), then the text. An agent-to-agent line
  is tagged `from → to`, e.g. `/words › prefetch → /words › audio`. The
  avatar's name is the `agentId`, else the label.
- **The owner's own line** to a node shows `→ /words › prefetch`.
- **Telling streams apart.** Every line with a node has a 2px left border in
  `oklch(0.7 0.09 <hue>)`, with the hue hashed from the node's path. Lines
  from different nodes therefore alternate colours.
- **Accessibility.** The line's tooltip and its sr-only text include the
  node, e.g. "prefetcher (/words › prefetch): …".
- **No node.** A line with neither a node nor a target renders exactly as
  before.
- **Addressing a node.** Type `@/words › prefetch ` (or `@/words/prefetch `)
  at the start of the input. While you type `@/…`, a list offers the
  connected listeners' nodes (Tab or Enter picks the first). Sending makes
  that node the **target**.
- **The target chip.** The target shows as a small chip above the input,
  `→ /words › prefetch ×`. Its × (or Backspace in an empty input) goes back
  to the main thread, which is the default and shows no chip.
- **`setTarget(path)`** (exported by `DebugChat.tsx` and the widget module,
  and on `window.__lkDebugChat.setTarget`) sets the target from outside. It
  is meant for the state tree: selecting a node will target it. The target
  is kept on `window`, so a hot reload keeps it.

## Agent edits of voice messages

STT gets words wrong, and it has no context on the conversation. The chat
lane does: it may **polish the owner's latest line** when that line came from
the widget's own mic, so the log reads what was meant.

**Which lines are voice.** The widget sends a line `source: "stt"` when the
draft is exactly what the mic left there: an STT final sent on its own, or
dictation sent unchanged (`dictatedDraft` / `draftSource` in
`packages/debug-chat/src/wire.ts`). Typed lines, and dictation edited before
sending, carry no source. `eval.ts chat` prints `"source":"stt"` on such lines
— that is the cue that an edit is allowed.

**The command** (chat lane; uses the saved grant, never pairs):

```bash
bun scripts/dev/eval.ts edit --last --no-pair "Fix the sync button on /words."
bun scripts/dev/eval.ts edit <msgId> --no-pair "Fix the sync button on /words."
echo "polished text" | bun scripts/dev/eval.ts edit --last --no-pair -
```

Prints the hub's `{"type":"edited","id","thread","text","raw","edited"}`, or
fails with the rule it broke. Polish, then reply.

**Polish with the context, or not at all.** Fix punctuation, words misheard
as a homophone that the context disambiguates, and stutters. Never change the
meaning, never add or drop a word, never use a word the context does not
contain. If unsure, do not edit: the raw line stands. The context is what the
voice line carries and what `eval.ts chat` prints with it:

- `scene` — where it was spoken: the page's `path`, `title`, and `screen`, the
  text visible on screen outside the chat and not hidden by CSS (the deck's
  words, the book's paragraph), up to `MAX_SCENE_SCREEN` (2000, the selection's bound).
  Captured by `pageScene()` (`packages/debug-chat/src/scene.ts`) when the line
  is sent; voice lines only (`cleanScene` in `wire.ts`).
- `context.selection`, when something was attached;
- the thread's other kept lines.

The hub holds every edit to that (`polishCheck` in
`packages/debug-chat/src/polish.ts`, on the words as `Intl.Segmenter` splits
them, the same for every script): punctuation, spacing, case and width change
freely (marks inside a word too: cant → can't); a replaced run must be in the
context as whole words ("now" is not in "snow"), must not merely drop or add
characters (不要 → 要 is a removal), and stays within 2x the length of what it
replaces (the same stretch of audio); a removed run only if it repeats what
is next to it; added words never. A refusal reads `not polished, the raw line
stands: …`.

**Off switch.** `stt.polish-off` at `/dev/flags` (docs/feature-flags.md):
on, every edit is refused (`polish is off …`) and the chat keeps only what was
heard. The hub asks the main Worker's `DebugSessions.flag()` on each edit; only an
answer of exactly `false` lets polish through (busy or an error: the raw line
stands). A main Worker without `flag()` means not off, so deploy order does
not matter. Off (the default) is the behaviour above.

**The rules** (`DebugHub.edit` in `workers/push/src/debug.ts`, each one unit-tested
in `unit/debug-hub.test.ts`). `{type:"edit", id, text}` is accepted only if:

- the sender holds a live owner grant (chat, or eval, which implies chat); a
  pairing made for a friend never may;
- the target is the owner's **latest** line in the owner thread (agent replies
  after it do not count; any earlier line is refused);
- that line has `source: "stt"`;
- it was polished fewer than `MAX_EDITS` (3) times, and the text changes.
- the polish passes `polishCheck` against the raw text and the context;
- `stt.polish-off` is not on.

Friends' threads and lines can never be edited. On success the stored line
keeps the first STT text as `raw` (only the first), takes the polished
`text`, and gets `edited: {at, by, count}` (`by` = the agent id, else the
controller's label). Pages and listeners hear `{type:"edited", …}`.

A spoken line that continues the last one can amend it (below): the rules for that,
and how its polish waits for the passage's end, are in the next section.

**On the page.** The line changes in place (a floating line too) and is
never read aloud again. A small muted sparkle after it marks it polished
(tooltip "Polished", zh 已润色; long press on touch shows it). A tap shows
the raw STT text, muted; another tap goes back. The icon is one slot:
`POLISHED_ICON` in `packages/debug-chat/src/icons.tsx`, or the widget's
`polishedIcon` prop.

## Continuous speech amends the last line

The owner, 2026-11-06 01:13 JST: "连续的语音输入应该能够有能力编辑已经发出去的消息", and 01:14:
later words carry what the earlier ones really were, so polish the whole passage
afterwards. Flag **`stt.merge`** at `/dev/flags`, default off. Off, nothing changes:
the hub stamps nothing, the page never asks. Rule and helpers:
`packages/debug-chat/src/voice-merge.ts`; hub: `merge`, `unmerge`, `passageEnd` in
`workers/push/src/debug.ts`.

**How it flows.** With the flag on the hub stamps an owner's voice line `mergeable`.
The page's next spoken line carries `continues: <that id>` when `mergeVerdict` passes
locally and no voice command ran since. The hub runs the verdict again and alone
decides. Yes: the line changes in place and its `id` and `at` stay the first part's.
No: an ordinary new line, as ever.

### When an utterance continues the last one

All of these, or it is a new line:

| Check                                                                                   | Why                                                                      |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| The thread's **very latest line**, by anyone, and `continues` names it                  | an agent's reply or ask card in between keeps it apart                   |
| Same page label (path + device), same `to`                                              | another device, or a page he moved to, is a new turn                     |
| Both `source: "stt"`, the earlier one stamped, not settled, not split                   | typed lines and friends' never                                           |
| No ask card open right before it, none answered since                                   | an answer stays its own explicit act                                     |
| No selection or files on either, neither through the wake word                          | such a line is about those, or a new turn                                |
| Neither is a short answer (`SHORT_ANSWERS`: yes, ok, 是, 行, はい…), nor tagged `other` | fragments cannot add up to an approval; a stranger is not his next words |
| Under `MAX_CHAT` joined, under `MAX_MERGE_PARTS` (40, a Durable Object value's bound)   | caps hold                                                                |
| The earlier line does not end in `? ？ ! ！`                                            | that ended it, however soon he went on                                   |

Then a **signal and its window**; no timestamps means no merge:

| Signal                                                                                                                       | Window                                             | Reading                                                    |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------- |
| `cut`: the capture hit `MAX_UTTERANCE_MS` (`t_cut`)                                                                          | next start ≤ `JOIN_WINDOW_MS` (2500) after its end | it never stopped by itself                                 |
| `open`: ends in a clause mark or no mark (`, ， 、 ; : …`, also `，。`)                                                      | same                                               | a text signal, read from punctuation classes, any script   |
| `quick`: a plain stop, voice-to-voice silence ≤ `redemptionMs` (1400), **and the Mac's voiceprint signed both lines as him** | as stated                                          | the 600 ms endpoint cut where the VAD's own would not have |

Neither window is new. `JOIN_WINDOW_MS` rejoined about 17 of 18 cut lines on his
clips (#357). `redemptionMs` is the silence the VAD itself treats as inside one
utterance. New marks on the line's timing: `t_speechStart`, `t_cut`.

**Why `quick` needs the voiceprint: the evidence.** 211 recorded finals in
`~/lianki-voice-clips` (2026-10-29 to 10-31, read as text and timestamps only):

- 195 of 210 end in a plain `。` or `.`, 11 in a question mark, 4 in no mark. "No
  sentence end" barely exists as a signal: STT stops every fragment. His own example,
  "那你能不能给。", ends in a stop.
- Gap plus plain stop alone would merge 83 of 181 neighbouring pairs. 66 of those
  involve junk (`The.`, `Yeah.`, room talk transcribed), and most of the other 17 read
  as room talk or separate things ("…这里跳转过去。" + "谁给你咖啡放名箱吗。"): noise restarts
  the VAD as fast as he does, and the clips' 800 ms pad hides anything finer. The
  blip guard drops most of the junk today, not the room talk.
- So a plain stop alone is not enough, and the signed tag is the one thing the voice
  path has that tells him from the room. Cost: with no print on the device (or the
  cloud STT, whose 1400 ms endpoint leaves no such gap anyway), only `cut` and `open`
  merge, and his example stays two bubbles there.

The count is a hand reading of a small, noisy, pre-guard set. The rule starts here
because a wrong merge is worse than two bubbles; `debug.merge` and
`debug.merge-refused` (with a reason) in `wrangler tail lianki-push` are what to tune
it from.

### An agent already on it

A busy beat does not stop a merge: `--ack` beats every line at once, so a beat
would block nearly all of them. Only a line it has _said_ counts. An agent working
on the first fragment hears `{type:"edited", text, parts, merged}` with the complete
text and **must read it again before it acts or replies**. Once it has replied, the
next utterance is a new line, which is also the way to tell it something more.

### What a listener hears

`{type:"edited", id, thread, text, raw, edited, parts, merged:{id, text}}`, the
existing event: `text` is the whole line so far. `eval.ts chat` prints it (`parts` as a
count) and `--ack` beats for it as for a new line. `edit --last` targets it as usual.
An undo: `{type:"edited", …, split:[{id, text, at}…]}`.

### Polish, once, when the passage ends

- A merge resets the text to the merged raw, so polish reads what was heard, never the
  last polish (errors do not compound). Every part stays in `parts`. `edited.by` is
  `merge`, `edited.count` still counts polishes only.
- While a merged line is being spoken an `edit` is refused (`still being spoken`). A
  polish of the first fragment that arrives late fails `polishCheck`: it drops words.
- The page sends `{type:"passage-end"}` after `PASSAGE_END_MS` (the same 2500) with no
  speech heard and no transcript out, only for a merged line. The hub settles the line
  and tells listeners `{type:"polish-due", id, text, raw, parts}`, once. **That is the
  lane's cue to run `eval.ts edit` on it.** After 30 s (`MAX_UTTERANCE_MS`) with no
  passage-end (a page gone) an `edit` is taken again, but nobody is told: the raw stands.
- The rules are `polishCheck`'s, unchanged. New: a merged line's parts are in its
  context, so a word later in the passage may correct an earlier one (流失 → 流式).
- `stt.polish-off` on: merges happen, no polish-due goes out, every edit stays refused.
- A single voice line polishes as before, at once. No polish-due, so no extra wake.

**Cost.** Polish is the lane's Claude turn; the hub calls no model, so nothing new
is billed per call. Today N fragments are N lines and up to N polishes. Merged, they
are N wakes (each `edited` is a wake, as the chat line was) plus one for `polish-due`,
and exactly one polish, however long the passage; flag off, nothing. `MAX_EDITS` (3)
still caps a line's polishes, and a settled line takes no more parts. Hub: one flag
read per 30 s on voice lines (`flag()`'s budget is 60 a minute), one storage write per
merge, one uncached `flag()` read per passage for `stt.polish-off`.

### Undo

A small ↩ beside the sparkle on a merged line (`debug-chat-unmerge`). `{type:"unmerge",
id}` from an owner's page splits it back into the lines it came from, in their place in
the thread even after a reply, each with its own raw text, time, timing and speaker tag.
Honest about what the hub stores: nothing is lost, and a polish goes with the merge. The
split lines merge no further. It works with the flag off too.

### Voice commands, cues, guards

- **Commands.** A command is kept by a tap (`voiceTap`) before the chat sees it, so
  it never merges, and `micTaps().kept()` moves, so the lines around it stay apart.
- **Cue.** A line the page asks to merge plays `amend`, one soft note at half the send
  cue's level, under the send cue's switch and rules (voice-mode.md, "Cues"). The hub
  may still refuse (a reply on its way): then a new line came with the soft note. Rare,
  and not worth waiting a round trip for.
- **Hallucination guard, blips, voiceprint filter.** They drop a final before it reaches
  the draft, so a dropped line sends nothing and asks nothing. The line after it may
  still continue the one before: the dropped one was never said.
- **Speaker tag.** The weakest of the parts with all their signed words; a part with
  none leaves the line with none, so an unverified part never rides on a verified one.
- **Friends.** Their lines never get the stamp, and friends' lines still can never
  be edited (`friendChat` returns before any of this).

## Voiceprint: enrolment and delete by a tap

The chat menu's **Voiceprint** (owner pages with a local STT) opens a panel
over the bar (`VoiceprintPanel.tsx`, `voiceprint.ts`): enrol this device
(a consent card first, nothing captured until "I agree, start"), the
sentences to read, and "Delete my voiceprint" (a confirming tap). The print
lives only on the Mac; voice lines it verified as him get a small green
check (`VoiceMark`). The same rule as recording: starting enrolment and
deleting are taps, never voice. Details: [local-stt.md](local-stt.md),
"Voiceprint".

## Ask cards: approvals by a tap

The agent can ask with options instead of open text; the page shows them as
pills the owner taps (`packages/debug-chat/src/ask.ts`, `AskCard.tsx`).

```bash
bun scripts/dev/eval.ts ask --q "Deploy lianki-push now?" --opt "Deploy" --opt "Wait"
bun scripts/dev/eval.ts ask --to owner --q "Days?" --opt Mon --opt Tue --multi \
  --q "Time zone?" --opt UTC --opt Local --wait --timeout 900
```

- Wire: the controller sends `{type:"ask", questions:[{id?, question,
options:[{id?, label, recommended?}], multi?}], expiresAt?, to?}` (or one
  `question` + `options`); the hub answers `{type:"asked", id, askId,
thread}`. In `eval.ts` the first `--opt` of each `--q` is the recommended
  one; `--wait` waits for the tap (event-driven, no polling). Limits: 20
  questions, 8 options, a 7-day expiry at most.
- The page sends only `{type:"answer", askId, choices}`. The **hub** checks
  the ask is in that page's own thread, still open (one-shot, not expired)
  and that the choices fit it, then stamps `{choices, source:"tap", thread,
label, at}` on the line and sends `{type:"answered", id, askId, answer,
labels}` to the thread's pages and to the approved listeners; `eval.ts
chat` prints it as an `answered` line.
- A controller can never answer: `parseControllerMessage` refuses
  `type:"answer"`, so `source:"tap"` only ever comes from a page socket.
- Friends: `--to <email>` asks a friend in their own thread (they must have
  chatted once). They never see the owner's asks and cannot answer them; their
  answers reach listeners tagged with their `thread`.
- The card greys out after the tap, shows the choice, says "Expired" past the
  deadline, and stays in the history. A page from before this change (no
  `onAnswer`) falls back to sending the choice as a typed line — that is
  **not** a tap-grade answer.

**Security:** a hub-stamped `source:"tap"` answer from the owner's thread is
a high-confidence approval — a deliberate touch on the owner's signed-in
page. A voice line (stt) is **never** enough to approve anything sensitive:
it can be misheard, overheard or played from a speaker. A typed line is no
approval either. Ask with a card and act on the `answered` event.

### The up-arrow to a question above

Owner, 2026-11-06 15:32 JST: "liagent 提问滑过屏幕，如果上面有未回答的问题，我们要显示一个向上箭头按钮，点击跳到未回答提问".
While an open ask card has scrolled off above the log's view, a round up-arrow
(`debug-chat-ask-jump`) floats just over the bar; with several it shows their
number. Each tap goes to the nearest above and it is gone when none is. Rules:
`ask-above.ts`; DOM: `ask-above-dom.ts`.

- **Which count.** `askState` "open" only. An answer from any device arrives as
  the hub's `answered`, DebugEval stamps the line, and the card stops counting in
  that render. An expiry is read at the next render or tap: no timer for it, so
  a card past its deadline can stay counted until then, and a tap never goes to it.
- **Above.** One IntersectionObserver rooted at the log, its region running from
  the top edge (less `ABOVE_INSET_PX`, the fade) down past any history's end. With
  the plain view as the region, a card jumped from below the view to above it in
  one frame never intersects and is never reported. A card whose pills still show
  is not above.
- **Place.** Left of scroll-down's slot, shown or not: a jump brings that button up,
  and a second tap on the same spot must not land on it. While it shows, the newest
  run of lines keeps room beside it (`jumpRoom`: its end padding is the button's
  width and slot, its height at least the button's, its text at the bottom), so it
  covers no line or pill and the newest line still sits at the log's bottom. Never
  an empty row under the last line: that row (#641, `JUMP_ROW_PX`) grew the resting
  log from 70 to 106 px with 43 px blank under the newest line, the owner's
  2026-11-07 18:10 JST "滚动不在正确的位置，它的下面半个窗口是空的". Hidden under a
  panel, the + menu and the inbox. When a tap hides the arrow (or changes its
  count) the room goes or narrows and the run reflows; a card inside a long run
  of one sender's lines then moved up past the top, so for 1.5 s after a tap
  (`REALIGN_MS`) the tapped card is put back at the top in the same frame.
  The run goes to its room's bottom as a ROW (`flex-wrap` + `align-content:
flex-end`), never by `align-items: flex-end`: that sent the avatar to a long
  run's last line, away from its first (owner, 2026-11-09 13:42 JST, desktop).
  `bun scripts/dev/debug-chat-avatar-qa.mjs [--shots <dir>]` checks the newest
  run's avatar is on its first line (±2 px) and clear of the ETA bar, from Li and
  from the owner, short and long, with and without the arrow, at 1440×900 (panel,
  sidebar) and 390×844 (panel, full screen), light and dark.
- **At rest** the log is 3 lines, too short for a card, so a tap holds it open
  (`held: "open"`, via `wireLogHold`'s `onReady`), glass and all, until a press
  outside the chat, as a press on the history while typing does.
- **Not in compact mode.** The log is hidden there and the compact view shows the
  newest two open asks itself; a third and older has no arrow.

Checks: `bun scripts/dev/debug-chat-ask-jump-qa.mjs --shots <dir>` (silent browsers,
Chromium and WebKit, 390×844, light and dark); the rules in
`unit/chat-ask-above.test.ts`. `bun scripts/dev/debug-chat-newline-qa.mjs [--shots <dir>]`
checks that each new line (the agent's and the owner's) lands at the log's bottom,
readable, with at most a few px under it, with and without the arrow, and that the
arrow covers no line's text or pill (text rects), at 414×848 and 320×568, both engines
and themes, at rest and typing.

When the log looks wrong on his phone, `bun scripts/dev/chat-scroll-diag.ts` reads it
once through `eval.ts --no-pair` (read-only, never pairs): the log's box and scroll,
paddings, the newest line and the blank under it, the arrow, the bar, the open asks.

## Full screen

Owner, 2026-11-07 (speech, confirmed by repeating it): "给我的伙伴全屏". The open
chat can fill the whole app, on the iPhone home-screen app and on a desktop.
Rules: `packages/debug-chat/src/full-screen.ts`; unit tests:
`unit/chat-fullscreen.test.ts`.

- **Who.** Flag **`partner.fullscreen`** (`/dev/flags`, default off): on, every
  chat user gets it; off, only the owner's pages (`flag || owner`, the hub's
  verified `owner`). The root layout reads the flag once per request and passes
  it down (`OwnerBoots` → `DebugEval` → the widget's `fullScreen` prop). Never
  on another site (`embedded`: the userscript's widget, `/embed/partner`).
- **In by a drag, no button** (owner, 2026-11-09 18:25 JST: "no dedicated
  fullscreen button; it should happen when the input box is dragged to the very
  bottom"). Dragging the open chat (its grip or the bar's edge) until its bar is
  pushed flush against the bottom edge (the drag keeps it on screen, so it rests
  flush within half a pixel) enters full screen on the drop (`dropEntersFull`).
  Only the bottom: the top edge would hide the history (18:26 JST), so a bar
  pushed against the top stays a panel there. In full screen a drag on the grip
  or the bar's edge that goes `FULL_LEAVE_PX` (48 px) up leaves it
  (`dragLeavesFull`): the panel comes back, its own size, and follows the finger
  from there; a smaller wobble, sideways or down, stays. Without a drag (the
  keyboard, a screen reader): the menu's **Full screen** row (a double tap on the
  grip), `fullScreen` in 16 locales. The old ⤢ toggle over the panel's top
  corner is gone; the Gantt's own ⤢ is unrelated.
- **The way out** (owner, 18:25 JST: "an exit button is still needed"): a pill,
  ✕ and the words `fullScreenExit`, at the top corner under the notch, 40 px tall
  with the 40 px tap area (`tap-40`), focusable, AA in both themes
  (learning-partner.content.ts, 16 locales with context; `ui-strings.ts`
  en/zh/ja for hosts with no strings). Left by it, Escape or the menu row, the
  panel is as it was, where the drag dropped it (on the bottom edge).
- **Ways back.** The exit button, a drag up, Escape (after the tree's and the + menu's own
  Escape; it never turns the mic off), and Back: entering by a tap pushes one
  history entry through the host's `backToClose` (Lianki: `openBackToClose`,
  docs/ui-state.md "Back closes an overlay"), same URL so `?live=` stays.
  Full screen restored by a reload takes its entry at the first press or key
  (the browser may skip an entry pushed with no gesture), and reopened from the
  pill at once, so Back leaves full screen first there too (owner, 2026-11-08;
  `fullScreenBack`, unit/chat-fullscreen-back.test.ts). Left by the exit button, a drag up or
  Escape, the entry is consumed: no orphan, no double back. Minimizing to the
  pill leaves it; reopening comes back full screen, since the choice is kept.
- **Nothing remounts.** The same section, log, input and mic are restyled in
  place, so the thread, the draft, its focus and caret, and the mic are as they
  were. The line being read keeps its place on screen across the switch (as far
  as the log's scroll allows); at the end it stays at the end. The panel's own
  position is untouched, so the way back lands where it was.
- **Kept per device**: `lk:pref:chat-view` `full` (`chatPrefs`), never synced;
  other tabs on the device follow it through the `storage` event, as compact does.
- **Layout.** The box is the visual viewport, from `visualViewport` resize and
  scroll events (no polling): with the on-screen keyboard up (iOS shrinks and pans
  only the visual viewport) the box shrinks to the visible area, so the composer
  stays above the keyboard and the bottom safe area is not padded (`data-kb`).
  Pinch-zoomed, it is the layout viewport. The notch and landscape sides pad with
  `env(safe-area-inset-*)`; no horizontal scroll at 320 px. The log takes the
  height the bar leaves and always takes the touch.
- **Phone or sidebar** (owner, 2026-11-07 20:31–20:34 JST). Narrower than
  `SIDEBAR_QUERY`, `(min-width: 35em)` (his number, in em), full screen is the
  whole screen. Wider, it is a full-height sidebar docked to the right edge,
  `SIDEBAR_W` = `clamp(20rem, 32vw, 28rem)` wide (no drag-to-resize pattern
  exists in the app, so a fixed width: 409.6 px at 1280), with a 1 px oklch
  left border. The page beside it stays usable: while it is up the page's root
  is padded on the right by its width (`--lk-chat-side`, `sidebarReserve`), so
  the page reflows clear of it and scrolls as ever. A host's own fixed bars do
  not reflow by themselves; they can read `--lk-chat-side`.
- **The bar spans it** (owner, 2026-11-07 20:30 JST: the input across the full
  width). On a phone the bar is the screen's width less the safe areas and the
  panel's own 0.5rem gutter (`fullBarSpan`); in the sidebar it is the
  sidebar's width, as the log. The cluster `[grip | + | mic]` is at its left
  (also on a left-edge, mirrored panel) and the input takes the rest.
- **Glass.** The typing glass with the sheet's tint and blur, covering the chat's
  area, which in full screen is the screen; nothing outside the chat is blurred.
  The bar keeps its own box there, and the `@/…` completions get theirs, since the
  glass behind them is the log.
- **Everything else as ever.** History scroll, scroll-down, the up-arrow to an
  unanswered ask (#641) and the cards, markdown, the mic, the + menu. Compact mode
  waits while full screen is up (it is for reading the whole chat) and applies
  again on the way back; the drag-on-the-bar full-screen log is not started (the
  drag only scrolls).

Checks: `bun scripts/dev/debug-chat-fullscreen-qa.mjs [--shots <dir>]` (silent
Chromium and WebKit, 414×896, 390×844, 320×568 and 1280×800, light and dark; the gate,
drop on the bottom edge (not the top, not short of it), the drag up out of it, the exit button (✕ and words, 40 px, AA, keyboard focus), the menu row, no enter button, the sidebar, the bar's and input's widths, overlaps, the page beside the
sidebar, draft, the same elements, the newest line on entering, side scroll, Escape,
Back, reload, an emulated keyboard, scroll-down, the arrow and a card). Not
covered by emulation: a real iPhone home-screen app's keyboard, its pan, and the
safe areas.

## Compact mode: only the last message while not typing

For talking to the chat by voice with less on screen (owner, 2026-11-01:
"相当于最小化模式或者只显示最后一条消息", "让他减少干扰"). While the input
does not have the focus, the open chat shows only its last message, one line
of at most two rows with the avatar (never the name), as the minimized
chat's floating lines do. The bar, the input, the mic and the live interim
transcript are unchanged and keep working.

- **The setting** is per device: the chat's menu → "Only the last message
  while not typing" (zh 不打字时只显示最后一条消息), kept in localStorage
  `lk:pref:chat-view` (`chatPrefs` in `ui-store.ts`), off by default and never
  synced. Turn it on in the window where you want it (the installed /words
  app), and it stays off everywhere else.
- **Whole chat back**: a tap on the input (focus) or on the compact line, or
  a vertical drag on the mic or the empty input (the full-screen log).
- **Folding again** (`compact-view.ts` `foldIn`): after the latest hold —
  1.5 s after the input's blur, 8 s after a tap on the line, 3 s after the
  last scroll or touch in the log, and a new reply's reading time
  (`dwellMs`). Never while typing, while the log is scrolled up, or with the
  menu, the tree or the full-screen log up. One timer, re-armed when it
  fires; scrolling only moves a ref, so nothing re-renders per scroll.
- **Ask cards** (above) that are still open show in full above the line (the
  newest two), their pills tappable; an ask that is the last message is the
  line itself, in full.
- **State tree**: when the tree has the log's place, it stays.

Checks and screenshots: `bun scripts/dev/debug-chat-compact-qa.mjs --shots

<dir>` (silent browsers, getUserMedia refused, 390×844, light and dark);
the rules in `unit/chat-compact.test.ts`.

## Folding: open, pill, tucked into the edge

The owner reviewed the fold redesign in Slack on 2026-11-04 (storyboard:
`stories/chat-fold`). The rules are in `packages/debug-chat/src/fold.ts`,
and the unit tests are in `unit/chat-fold.test.ts` and `unit/anchor.test.ts`.

- **Open → pill.** The mark (left of the input) folds the bar toward
  itself into the pill, and stays under the pointer. Unchanged.
- **Floating lines follow the pill.** They start at the pill's own side,
  so the side follows the way the bar folded. The screen third no longer
  decides it, which fixes "folds left but lines right-aligned". The
  floating box is still clamped on screen (`anchor.ts`).
- **The third level, tucked, is removed for now** (owner, 2026-11-07
  20:32 JST: "第三级别", the edge-snapped fold, useless, to be rethought).
  The mark steps open → pill → tucked no more: on the pill a tap on the
  mark opens the chat again, and a pill dragged flush against an edge stays
  a pill there. A device that saved `tucked` shows the plain pill and the
  saved value is cleared. The handle code below stays dormant until it is
  rethought; nothing reaches it.
- **The grip** (owner, 2026-11-07 20:34 JST: the handle did not look
  draggable). The mark is a six-dot vertical grip (its own SVG, `GripDots`),
  `cursor: grab`, `grabbing` while held, labelled `dragGrip` (16 locales,
  with context). Its 44 px touch area, place and gestures are unchanged.
- **Pill → open.** The pill's Li (part of the pill, not a new button) opens
  the chat again, as does the grip, the menu's Restore row or `chat.open`.
- **The handle (dormant).** Tucked, the chat left one thumb-sized handle. Its shape
  is set by `HANDLE_SHAPE` in fold.ts: `"half"` (a half circle bulging from
  the edge, the default) or `"square"` (a rounded square). The owner has
  not picked one yet. The handle's touch area starts `TOUCH_INSET` in from
  the edge, because on Android a horizontal swipe that starts at the edge
  is the system's Back. A tap brings the pill back, and so does a
  press-and-drag that starts on the handle (the pill then follows the
  finger). Nothing relies on pulling from the edge.
- **New messages while tucked.** A dot shows on the handle while anything
  is unread, and the newest line peeks beside the handle for its dwell. A
  tap on that line brings the pill back.
- **Left edge: everything mirrors.** After each drag the chat keeps to the
  edge nearest the box's centre. On the left edge the row runs right to
  left: the mark sits on the inner side, the bar folds right, the lines
  end at the pill's right edge, and the chat tucks into the left edge.
  When the mirroring changes, the box shifts so the pill stays put.
- **Kept per device**: `lk:pref:chat-fold` (`tucked`, `edge`) in
  localStorage, never synced. Open or minimized stays in `lk:debug-chat-open`.

Browser checks: `bun scripts/dev/debug-chat-fold-qa.mjs [--shots <dir>]`
runs them in silent browsers at 390×844, with getUserMedia refused.

## Typing glass: the chat box frosts while typing

Owner, 2026-11-02 on /home: "帮我背景玻璃化，在我在这里打字的时候"; corrected
2026-11-03: "打字时的背景模糊应该只用于聊天框那一小块区域，不要全屏背景模糊".
While the chat's input has the focus (the `typing` state), the chat box's own
area gets a glass background (`data-testid="debug-chat-typing-glass"`, a child
of the box at `-z-10`, `-inset-1.5` past its edge, rounded): a light oklch tint
in the page's tone under `blur(12px) saturate(1.4)` (`-webkit-` too, for iOS
Safari), with a 1px oklch hairline ring. It covers the whole panel, the
shown messages and the input together ("包括输入框和显示的消息"). Only the box: the page around it
stays sharp, and nothing catches taps (`pointer-events: none`), so the page
stays usable while typing. Rules and look in `typing-glass.ts`.

- **Not full-screen.** #425 first shipped a full-screen frosted layer with a
  tap-catcher; the owner corrected it the next day. Do not bring it back.
- **Fade** 150 ms both ways; none under reduced motion. It stays mounted and
  goes `visibility: hidden` after the fade, so at rest it is not painted.
  Without backdrop-filter, or under reduced transparency, the tint goes
  near-opaque (0.9).
- **Backdrop root:** the box sits at `opacity-60` at rest, and an ancestor
  under opacity 1 would stop the blur from seeing the page. While typing
  `focus-within` makes it opaque, so the glass blurs the page as it should.
- **One frame** (owner, 2026-11-03: "点进输入框、对焦之后……里面那个框框就没必要继续显示了";
  "尽量减少视觉上的嵌套数量"). While the glass is up it is the frame: the
  bar's own box is not drawn inside it (`barInGlass`: border transparent with
  its 1px width kept, no tint, no blur of its own), so caret, placeholder,
  mic and + do not move and the concentric geometry is unchanged. It fades
  with the glass; at rest the bar's resting border is back. In the same
  spirit nothing inside the glass draws a second box: the `@/…` completions
  are plain rows on the glass, the attached-selection chip keeps only its
  rail (`AttachChip flat`), the + menu has no border (its shadow is its
  edge), and its "soon" tag is plain text. Kept: the target chip's border
  (its colour names the node) and round buttons (their shape is the
  affordance).
- **The full-screen log, too** (owner, 2026-11-03 20:50 JST: "在输入框上拖动的这个全屏背景模糊").
  A vertical drag on the mic or the empty input no longer puts a sheet over
  the whole page. The same glass stays up and grows with the log: from the
  mic it is the panel (the log grown upward, and the bar); from the empty
  input, where the log leaves the flow for its own box, it is that box plus
  the same few px of edge (`glassAroundLog`). While it spans the log it takes
  the old sheet's stronger tint and blur (`SHEET_SCRIM`, `SHEET_FILTER`; the
  contrast checks in `unit/sheet-contrast.test.ts`), and the box goes opaque
  so the blur sees the page. Beside the log the page stays sharp.
- **Under the finger** (owner, same evening: "开始拖动之后的输入框/聊天内容老是不在一个位置").
  Under the touch slop (`AXIS_LOCK_PX`) nothing moves, so a tap is still a
  tap. Past it, the switch to the full-screen log runs at once
  (`flushSync`), before the first move scrolls the log: its layout effect
  holds the line he was on where it was at the press, and when it ran after
  that first scroll it undid it, so the log lagged the finger by the slop
  for the rest of the drag. Now the lines keep their offset from the finger
  from the press to the release (inside the joystick's dead zone). Scrolled
  up, the release lands where he left it; at the end, a short drag springs
  back to the newest line (#443).
- **Not** minimized. Also
  on other sites (the userscript): it covers only the box, so the host page
  is untouched. Only on focus; glass while a draft waits unfocused would be a
  follow-up.

Checks and screenshots: `bun scripts/dev/debug-chat-typing-glass-qa.mjs
--shots <dir>` (silent browsers, 390×844, light and dark); the rules in
`unit/chat-typing-glass.test.ts`. The drag: `node
scripts/dev/debug-chat-drag-qa.mjs --shots <dir>` (iPhone 390×844 and
Android 412×915, light and dark): no backdrop-filter past the chat panel
during or after a drag on the input or the mic, and the finger-to-line
offset constant within a pixel from the press to the release. `shot.ts` cannot show it (no
backdrop-filter in DOM-to-image); use the QA script's shots.

**The + menu counts as typing** (owner, 2026-11-05 01:39 JST). While the +
menu, or the file picker it opened, is up, the panel leaves its faint idle
look (opacity 60%) and the glass is up, exactly as for a focused input. One
condition, `inputInUse` in `typing-glass.ts`, feeds both `showTypingGlass`
and `panelOpaque`; the menu closing (or the picker answered or dismissed)
ends it, as a blur does.

**The history drags while typing** (owner, 2026-11-05 01:52 JST, iPhone
PWA on /words). The log is click-through at rest, so with the keyboard up a
drag on the history went to the page behind it. While the input has the
focus or the mic is on, the log takes the touch (`LOG_TOUCH` in
`log-surface.ts`: `pointer-events: auto`, `touch-action: pan-y`,
`overscroll-behavior: contain`); the input keeps the focus, so the keyboard
stays. At rest it is click-through again (a press-and-hold engages it too:
"The history is glass until it is engaged" below). Checks: `bun
scripts/dev/debug-chat-typing-scroll-qa.mjs` (WebKit and Chromium, 390×844
touch).

## Markdown, safe HTML and links in a line

Owner, 2026-11-06 00:05 JST. Every line (log, compact, floating, a polished
line, its raw text) goes through `rich-text.ts`: `marked` to an HTML string,
the browser's inert `DOMParser` to a tree, an allowlist walk to a plain data
tree, and `RichText.tsx` to React elements. There is no
`dangerouslySetInnerHTML` and no HTML string reaches the page, so only an
allowed tag with allowed attributes can come out. No `style`, `class`, `id`,
`on*` or `data-*` attribute ever passes; script, style, iframe, object, form
and the like go with all that is inside them; another unknown tag gives way to
its text. With no `DOMParser`, or if anything throws, the line is plain text
with its links.

**Tiers** (`lineTier`), from what the hub stamps, never from the text:

| Tier       | Who                                                                                     | Gets                                                   |
| ---------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `html`     | an agent line with the hub's `ownerGrant`, in the owner's thread, not embedded          | markdown, the HTML subset, images from `IMAGE_ORIGINS` |
| `markdown` | everyone else: friends, the partner AI, his agents in a friend's thread, his own typing | markdown; raw HTML shows as text, an image as its alt  |

`ownerGrant` is set only in the hub's `say`, when the thread is the owner's:
that is, by a pairing he approved. A sender cannot set it: the hub builds each
line field by field. The partner AI's lines and friends' lines never have it, and
AI output is untrusted because a prompt can inject into it. A line kept from
before this has none: markdown. It stays on a stored line after the pairing ends.

**Links.** `chat-links.ts`: http(s) and bare `lianki.com/…` only. Punctuation,
closing brackets and scripts written without spaces end a URL; a host that is not
ASCII is not a link, so none reads as ours. On lianki.com a lianki.com link stays
in the tab through `onOpenPage`; any other opens a new tab with
`rel="noopener noreferrer"`. **The anchor's text is always the URL**: a labelled
`[docs](https://…)` shows `docs (https://…)`, the URL being the anchor, so no line
can dress one address as another, in any tier. A link carries `pointer-events-auto`
because the history is click-through at rest (log-engage.ts); the text around it
stays glass. A long press on a link is the platform's own (Copy link), not the
press-and-hold that selects the line. A table or a code block scrolls in its own
box and takes the pointer only while the history is engaged.

**Read-aloud** reads `spoken`, not `m.text` (`spokenOf`; DebugEval's `speakReply`
and the resume): the words without markup, a link's label not its URL, table cells
joined with commas, code blocks left out (a line of only code says nothing). A bare
URL is read as it always was. Each text keeps its offset in `spoken`, so the sentence
highlight (`sentenceRanges` over `spoken`) lands on the same words the voice reads,
across bold and links.

Tests: `unit/chat-links.test.ts`, `unit/chat-rich-text.test.ts` (the sanitizer
corpus, tiers, read-aloud; happy-dom's parser), the stamp in `unit/debug-hub.test.ts`
and `unit/partner-ai.test.ts`.

## Copying a message

Owner, 2026-11-05 01:34 JST, iPhone PWA on /reader: "这里复制不了". The chat
box is click-through (`pointer-events: none` on the section, so the page
under it stays usable) and the log inherited it. iOS will not long-press
select text that does not take the pointer, so there was no Copy. #537 made
each line take the pointer; that made the lines catch the wheel and clicks
meant for the page, so since the owner's 13:00 JST note below the lines are
selectable (`LINE_SELECTABLE` in `copy-line.ts`: `user-select: text` with
WebKit's prefix, the touch callout on) but take the pointer only while the
history is engaged. Long-press (or a mouse drag) and the platform's Copy do
the rest: a per-line copy button shipped in #537 and was dropped the same
night (owner, 2026-11-05 02:00 JST: selectable text is enough). The reader's
combo-click selection (`use-reader-select.ts`) ignores taps and selections
inside `[data-debug-chat]`, so copying in the chat never opens the reader's
card or clears what is selected there.

### The history is glass until it is engaged

Owner, 2026-11-05 13:00 JST, Mac Chrome on /books: with the input not
focused, a wheel or a click over the history must reach the page under it.
One rule, `logEngaged` in `log-engage.ts`: the history takes the pointer
(`LOG_TOUCH`: wheel and drag scroll it, its lines select) while

- the input is in use (focused, or the + menu / its file picker up),
- the mic is on, or
- it is **held**: a **press-and-hold on the history** (500 ms, the
  platform's long-press, within 10 px) engaged it and selected the line
  under the finger ("rest": the log keeps its height, so the line stays
  under the finger); or a press on the history while typing ("open": the
  press blurs the input, and the log stays open, glass and all, with no jump
  to the newest lines, so the drag selects what it started on); or a
  selection is open in the chat. A press anywhere outside the chat drops it.

At rest nothing in the history takes a pointer (the polish mark, sent files
and ask-card buttons keep theirs), so a wheel scrolls the page and a click
lands on it. **How to copy now:** press and hold a message (mouse or
finger): it is selected; ⌘C / Copy. Or tap the input first, then
long-press / drag a line as before. On the phone a second long-press on the
selected line brings up iOS's Copy menu if it did not show by itself.

The hold is seen at the window (`log-hold-dom.ts`), since the log takes no
events at rest: a pointerdown inside the log's box starts one `HOLD_MS`
timer; a move past the slop, the release, a cancel or a scroll stops it.
No polling. While a touch hold may be under way (and for the rest of a fired
one) `data-lk-chat-holding` on `<html>` turns the page's text selection and
touch callout off outside the chat, so the platform's own long-press does
not select the page under the finger; a mouse press is left alone until the
hold fires, so a drag-select on page text under the history still works.
The click that ends a fired hold, and its context menu, are swallowed: the
hold never presses the page's button under it.

Checks: `bun scripts/dev/debug-chat-passthrough-qa.mjs --shots <dir>`
(silent, Chromium and WebKit 1280×800 mouse, light and dark, a tall page
with a button under the history: at rest the wheel scrolls the page and a
click reaches the button; focused, the wheel scrolls the history, the page
stays, the input keeps the focus, a drag selects part of a line and the log
stays open; the hold selects the line without clicking the button; a click
outside makes it glass again; Chromium 390×844 touch hold over CDP). `bun
scripts/dev/debug-chat-copy-qa.mjs --shots <dir>` (390×844 touch: computed
`user-select` and `pointer-events` on a line at rest and focused, its text
selecting, no copy button, + menu opacity); the rules in
`unit/chat-log-engage.test.ts` and `unit/chat-copy.test.ts`.

### A selection started in the chat stays in the chat

Owner, 2026-11-05 11:05 JST, Mac Chrome: a drag from a chat line that went
past the box selected half the page. `select-fence.ts` (decisions, pure) and
`select-fence-dom.ts` (listeners, installed once per page by each mounted
`DebugChat`), event-driven only:

- A press on a line's text (the history engaged: see above) arms the fence and puts `data-lk-chat-selecting`
  on `<html>`; a style rule then makes every element outside the chat (not
  its ancestors, not an embed's shadow host) `user-select: none`, so the drag
  has nothing out there to take. It stays up while the selection that press
  made is open (iOS's handles move it with no press of their own), and drops
  on the first press outside the chat, before the page's own selection
  starts. A tap on the chat's buttons never sets it.
- On every `selectionchange`, a selection anchored in the chat whose focus
  has left it gets its focus put back at the chat's first or last selectable
  text: the way the pointer left (above or below the box, or the line it
  started on), else document order.

WebKit keeps a scripted focus in non-selectable text as it is in the DOM but
selects none of it; Chromium moves it and the clamp puts it back. Selections
outside the chat are untouched; the reader's hook already ignores ones
anchored in the chat. Checks: `bun scripts/dev/debug-chat-select-fence-qa.mjs`
(silent, Chromium and WebKit, mouse drags up and down out of the chat over
page text, a handle-like scripted move, then a drag on the page);
`unit/chat-select-fence.test.ts`.

## Quiet lines

Every agent line is shown; what changes is whether it is also read aloud.
There is no time of day in it, and no setting
(owner, 2026-11-01).

**Which `say` to use** (agents, read this):

| Line                                                                     | Command                   | Read aloud                     |
| ------------------------------------------------------------------------ | ------------------------- | ------------------------------ |
| FYI, progress, "deployed", "PR opened", deploy notices, anything unasked | `eval.ts say --quiet "…"` | never                          |
| the answer to what he just said or asked                                 | `eval.ts say "…"`         | yes, by the page's usual rules |
| an ask card (approval needed; `eval.ts ask`, PR #384)                    | `eval.ts ask …`           | yes, like a plain line         |

Default to `--quiet` whenever the line is not a reply to him. `--loud` is
deprecated: `eval.ts` still accepts it and prints a note, and the line goes
as a plain `say`.

**Wire.** `{type:"say", text, quiet?: true}`. The hub
(`parseControllerMessage` in `lib/dev-eval.ts`) keeps `quiet` only as
boolean `true` and drops anything else (an old `loud` included). It copies
it onto the `ChatMessage`, so pages get it live and in history, and logs it
in `debug.say`.

**On the page** (`packages/debug-chat/src/speak-rules.ts`, gated in
`voice.ts` `gateVoice`), on top of the usual rules (mic on; or the speaker
toggle on and either the mic used in this tab or the input focused):

0. **Mic used here, sticky** (owner, 2026-11-04: "最近用过 mic 输入的话，回我的打字消息也要用语音"):
   once the mic has been on in a tab, replies are read there with the
   toggle on whether the input has focus or not, typed lines included
   (sessionStorage `lk:agent:voiced`). There is no time window: it lasts
   until he turns "Replies read aloud" off, which clears it; his mute always
   wins. The menu row says "Replies read aloud (mic used)" while it holds,
   "Replies read aloud while typing" when only the focus rule applies.

1. **Quiet** (`quiet: true`): never spoken, even with the mic on.
2. **Hidden page or locked screen** (`document.visibilityState` "hidden"),
   **on a phone**: never spoken (the browser would not let it). On a
   computer this rule is off: see "Background tab on a computer" below. Hiding the page also stops a
   reading under way. When the page is visible again, the newest line that
   arrived while it was hidden is read once (not a backlog); the lines left
   unread show a small note, "not read aloud: the page was in the
   background" (`ChatStrings.notReadHidden`, `data-testid="debug-chat-unheard"`).

A line kept silent is logged as `{ev:"voice-silent", why}` (quiet, hidden)
on the voice session's log, and a missed line read on return as
`{ev:"voice-missed"}`. Quiet lines carry `data-volume="quiet"` in the log,
for tests; they look the same.

**Background tab on a computer** (owner, 2026-11-04: "pc页面切走不要马上停语音";
`packages/debug-chat/src/voice-bg.ts`, unit/voice-bg.test.ts). A computer is
a fine primary pointer that can hover (`(hover: hover) and (pointer: fine)`).
There, switching to another tab or window stops nothing, with no grace
period: the mic keeps listening and the reading goes on until he stops it.
The paths that used to stop it, all now phone-only on a computer:

| Path                                    | What it did on hide                                          |
| --------------------------------------- | ------------------------------------------------------------ |
| `voice.ts` `gateVoice` visibilitychange | `voice().stop()`: the reading and its queue                  |
| `speak-rules.ts` `silenceHere`          | every new line silent while hidden                           |
| `DebugChat.tsx` hide effect             | stopped the reading (mic off)                                |
| `DebugChat.tsx` reading-left mirror     | froze the "read on next page" queue                          |
| `DebugEval.tsx` hub socket `wanted()`   | disconnected 30 s after hide: no lines out, no replies in    |
| `local-stt.ts` `visible()`              | a dropped STT socket waited for the page to be visible again |

The hub socket now stays while the voice is busy (mic on, speaking, or
queued; `keepHub`), and the local STT socket reopens on its close event
while hidden (`sttMayReopen`): events only, the existing backoff, no polling.
Audio frames go out from the audio callbacks, not timers, so timer throttling
in hidden tabs does not hold them back; Chrome on a computer keeps a running
AudioContext and speechSynthesis going in a background tab (Safari may
interrupt it). Echo cancel is the mic track's own and is unchanged.

**The title hint.** While the voice runs in a tab he is not looking at
(hidden, or the window unfocused), the tab title starts with
"🎙 Lianki voice on · " (🔊 when only reading; `voiceBgWords` in
ui-strings.ts, en/zh/ja), besides the browser's own mic indicator; it goes
when the voice stops or he is back (`app/components/useVoiceTitleHint.ts`).

**One tab listens.** Another Lianki tab turning its mic on takes the voice
over (`debug-chat-tabs.ts` `onTakeover("mic")`): this tab turns its mic off,
stops reading, and so shows no hint. A tab he newly focuses takes over a
hidden tab's reading with the mic off (`onTakeover("focus")`); a mic tab
keeps the voice whichever tab is focused.

**Phones** keep the old behaviour: hiding stops the reading and silences
lines, and the hub socket idles out; mobile browsers suspend background
audio and the mic anyway.

**No voice on the device.** With the output on "speech" (the default), a
reply in a language speechSynthesis has no voice for (some Android Chromes
report `getVoices()` = 0) is read through the cloud (`/api/words/tts`,
`voice-out.ts`) instead of staying silent; it is logged with
`fallback: "no-voice"`. The cloud's `<audio>` element is unlocked in the
first gesture on such a device.

**Hot-loadable.** The gate wraps `reply` on the shared voice session
(`globalThis.__lkVoice`), so a hot-loaded widget applies these rules even
under a deployed DebugEval that still calls `speakReply(text)` without the
line.

**Cleanup.** An older build kept a time-of-day setting under
`lk:agent-quiet-hours`; the gate removes that key once on load
(`dropRetiredKeys`), so nothing of it is left on his devices.

Tests: `unit/speak-rules.test.ts` (the rules, the gate, the missed line, the
cleanup), `unit/voice-session.test.ts` (the no-voice fallback),
`unit/debug-hub.test.ts` ("say --quiet"), `unit/dev-eval.test.ts`,
`unit/node-args.test.ts`.

## Lanes and voices

Several agents talk in the owner's chat — the chat lane (main), codex and
agy — and he tells them apart by ear and by eye (owner, 2026-11-07). One
table holds all of it as data: `packages/debug-chat/src/voices.ts` (`LANES`,
`VOICES`). A lane has a voice id, a name tag and a mark (a small SVG on an
oklch disc, `LaneMark.tsx`); main has no mark, so its lines look as before.

**Which lane.** A line's `lane` field (`eval.ts say --lane codex`, default
`$LIANKI_LANE`), else a leading `【codex】` / `【agy】` in its text. The prefix
is then taken off what is shown and read (the name tag says it). A line
with neither is main, exactly as before. `say --voice main|calm|bright`
reads one line in another voice (or one of its own: "A line's own voice"
below). The hub checks both ids and stores them with the line.

**Device voices** (speechSynthesis). Main, the chat lane, is cute: a
young, bright voice with a cat-girl feel (owner, 2026-11-07 20:34 JST) — the
first natural voice it prefers (Meijia, Lili, Nicky, Samantha, O-ren, …),
else today's pick (`pickVoice`), always at pitch 1.1. The others each take a different installed voice _model_ — another name,
never a Compact/Enhanced variant of one already in use — in four passes: a
natural voice the lane prefers by name, any natural voice, a preferred
Eloquence voice (Apple's Reed, Flo, …: robotic, but a different model), any
Eloquence voice. Novelty voices (Bahh, Zarvox, …) are never used. Only when
nothing is left does the lane reuse main's voice at its own pitch and speed.
A language's other locales that read it the same way are data
(`SIBLING_LOCALES`: zh-TW for zh-CN, not Cantonese zh-HK; en-GB/AU/… for
en-US).

| lane  | voice  | prefers (any language)                     | last resort        |
| ----- | ------ | ------------------------------------------ | ------------------ |
| main  | main   | Meijia, Lili, Nicky, Samantha, O-ren, Sora | (pitch 1.1 always) |
| codex | calm   | Li-mu, Daniel, Otoya, … then Reed, Rocko   | pitch 0.8, ×0.92   |
| agy   | bright | Lili, Tingting, Karen, Kyoko, … then Flo   | pitch 1.4, ×1.06   |

**Cloud voices** (`lk:voice-out` = cloud). Where an engine has several
voices for the language the lane gets its own speaker: Workers AI Aura-2,
English (main `luna`, codex `orion`, agy `thalia`) and Spanish (`celeste`,
`nestor`, `carina`),
asked as `/api/words/tts?…&speaker=` (the route keeps only speakers the
table names; a recording is skipped; an Aura-2 failure answers with MeloTTS,
never nothing). Everywhere else the cloud has one voice (MeloTTS), so the
clip plays at the lane's own speed — `shift` main 1 (his reading speed as it
is), codex 0.88, agy 1.2 — always with its pitch kept, the last resort. No
pitch shift (2026-11-07): on the owner's iPhone a pitch-free clip through the
voice context stalled mid-word (currentTime frozen ~200 ms, "续续" dropped),
and he does not want pitch tweaks. The pre-rendered Kokoro/VOICEVOX/Piper clips are fixed texts and are
not used for live lines.

The owner's mute, quiet lines and the hidden-page rule are unchanged: a
lane changes which voice reads a line, never whether.

Tests: `unit/voices.test.ts` (lane resolution, voice picks on fake voice
lists including this Mac's, fallbacks, the cloud speaker and shift, the
route's speaker, `say --lane/--voice`).

### A line's own voice

Owner, 2026-11-07 22:34 JST: one line can name the exact voice it is read
in, so he hears candidates for Li by just receiving them. `say --voice`
(eval.ts and `lianki-dev say`) takes, besides `main|calm|bright`:

| id               | what plays                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| `device:<name>`  | that voice of the phone (speechSynthesis), as it is; **even when his output is cloud**          |
| `melo:<lang>`    | the cloud's MeloTTS voice of `en es fr zh ja ko` (the clip asked in that language)              |
| `aura:<speaker>` | a Workers AI Aura-2 speaker of the table (`luna orion thalia` en, `celeste nestor carina` es)   |
| `eleven:<id>`    | an ElevenLabs **public preview clip** (its own words, not the line's), straight from ElevenLabs |
| `local:<name>`   | reserved for Mac-local engines (Kokoro, VOICEVOX): refused until one is built                   |

One strict parser (`voices.ts parseLineVoice`) is used by the CLI, the hub
and the page: an unknown kind, speaker, language or ElevenLabs id is
refused, never guessed. A device name is checked only for shape (letters,
digits, spaces, `()（）._'’-`, ≤ 64), since each device has its own; it matches
the exact name, then any case, then the same model at its best grade
(`device:Meijia` finds "Meijia (Enhanced)"). **Never silence:** a device
voice this phone lacks reads the line in its lane's voice by the usual
route; a cloud voice with no cloud output, or an ElevenLabs preview that
cannot play (refused before a tap on iOS, gone), reads it in the lane's
voice too. The same words in another voice are a new line (the 10-minute
re-delivery check keys on voice and text), so a demo in three voices plays three
times.

**Finding ids:** `eval.ts voices --no-pair` (or `lianki-dev voices`) reads
each open debug page's `speechSynthesis.getVoices()` once over the eval
channel (read only, never a loop) and prints them as ids, zh, ja and en
first, with the cloud's list; `--cloud` prints the cloud's list without
asking any page.

**ElevenLabs.** Paid voices, not wired into Li: no key, no generation, no
copy in R2. Only the premade voices ElevenLabs lists to anyone
(`GET /v1/voices`, no key) with a preview on its public storage are in
`ELEVEN_PREVIEWS` (Jessica, Sarah, Bella, Matilda, Alice, Lily, River, all
English). The community library the chat lane found (Lulu zh-TW, Kaori,
Pipi, Kano ja, Auri en) lists voices and previews only to a signed-in
account (checked 2026-11-07: "You must be logged in to use filters" / "to
fetch more than 3 voices"), so none of those is here. Their storage sends no
CORS headers, so a preview plays on its own element, not through the voice
context (which would play it as silence); `unlock()` primes that element in
the same tap. The app sets no `media-src` CSP, so nothing needed opening.

**On a box** (docs/box-oauth.md) the chat reads lines the same way: the
line's `lane` and `voice` reach `speakReply` as on lianki.com, and
`/api/words/tts?…&speaker=` goes to lianki.com through the box's fetch. Two
differences, found 2026-11-07: the gate's CORS answer exposed no app header,
so the page could not read `X-Voice` and took every lane clip as fallen back
to the one voice (fixed: `access-control-expose-headers: X-Voice,
Retry-After, Content-Disposition`; and a missing X-Voice no longer counts as
a fallback); and `lk:voice-out` is per origin in localStorage — it is the
synced pref `chat-voice.out` (docs/prefs-sync.md), so the box takes his
account's value after its first prefs pull, and until then reads with
speech. A `device:`/`aura:`/`melo:` voice ignores the output mode either way.

## The + menu: add to Lianki, attach the page selection

The round **+** at the start of the chat input (owner, 2026-11-03) opens one
menu in three groups (`packages/debug-chat/src/AttachMenu.tsx`, `attach.ts`):

- **Add** — the app's Create actions (add a link as a card, words from an Anki
  deck, import cards, AI words). The bottom island registers them with
  `setAddItems`; while a chat input with a + is on the page
  (`announceChatAttach`, event `lk:chat-attach`), the island's own ＋ is not
  shown. Anyone without the chat (not in debug mode, a blocked friend) keeps
  the island's ＋. Search still lists the same actions.
- **Attach to message** — a registry (`ATTACH_KINDS`), one entry per kind, so
  each new kind lands in its own change. **Page selection**; **File** and
  **Photo, video or audio** upload to the inbox (below, "Attachments and the
  inbox"; "Coming soon" where the host gives no uploads). URL import is the
  Add group's "Add a link as a card".
- **View** (查看) — **State tree** (状态树): toggles the state tree, as the
  bar's tree button did (owner, 2026-11-03: "状态树功能藏到加号里"; the bar
  has no tree button now, so it is `[mark | + | mic | input]`, and minimized
  `[mark | Li | mic]`). A `menuitemcheckbox`, checked while the tree is open, with
  the eval/preview sessions' count; while there are any, the + shows a small
  dot (pulsing when code just ran), so they are not lost with the button. The
  button's sideways drag through detents is gone; a tap on a chip opens it,
  and ←/→/↑/↓ on a focused tree row move the focus. Minimized there is no +:
  the mark's menu (double tap) has Tree. In the cross-site iframe (no attach)
  or while the chat is unavailable, the + is still there, holding only View.

**Page selection.** A phone clears the page's selection the moment the chat
input takes focus, so the widget remembers the last non-empty selection made
outside the chat (`createSelectionMemory`, on `selectionchange` and a
capturing `pointerdown`): an empty selection after a press in the chat keeps
it; a press anywhere else on the page lets it go; it also goes after 30 min,
when the chip's × is tapped, and when the line is sent. Never captured: a
selection inside the chat (`[data-debug-chat]`, the embed's shadow host
`[data-lk-chat-host]`), password and one-time-code/card fields, and anything
inside `[data-sensitive]` / `[data-lk-sensitive]` (any page may mark a part).

Choosing it puts a quote chip above the input (one line; a tap shows it whole;
× drops it). It is kept with the draft in `lk:ui:chat` (`attached`), and sent
with the **next line only** as `context: {selection, path, title, host?}` —
`selection` ≤ 2000 characters, `path` without query or fragment, `host` only
on another site (`cleanContext` in wire.ts, applied by the page, the hub's
`parsePageMessage` and the session store). The hub stores it on the line in
the sender's own thread — a friend's selection stays in their thread — and
logs only its length. The log shows it as a small quote above the line;
`eval.ts chat` prints it in the JSON line as `"context"`.

## Attachments and the inbox

The owner can paste, drop or pick files of any kind into the chat (owner,
2026-11-04). They are uploaded at once, kept in an **inbox** in R2
`lianki-blobs` (no other bucket), and the agent reads them from there.

**In the widget** (generic: `packages/debug-chat/src/files.ts`,
`FileChips.tsx`; nothing product-specific). The host passes `files`
(`ChatFiles`): `upload(file, onProgress, signal)`, `url(ref)`, and optionally
`maxBytes`, `list()` (items + usage), `remove(id)` and `actions(ref)` (host
buttons on a file). Without `files`, File and Photo/video/audio stay "Coming
soon" and paste/drop do nothing.

- **Paste** a screenshot or a copied file into the input; **drop** files
  anywhere on the chat box (while files are dragged into the window, an
  overlay over the whole box takes the drop, so a file never lands in the
  input as its name); or pick with **+ → File** / **Photo, video or audio**.
- Each file is a chip above the input: thumbnail (images, a local object URL)
  or its extension, name, size, a progress bar, × to drop it before sending
  (aborts the upload). Too big for `maxBytes`: refused before upload.
- A line waits for uploads still running and goes when they are done; files
  alone send after the usual pause, with their names as the text. The line
  carries `attachments: [{id, name, type, size}]` (`cleanAttachments`, at
  most 10) — refs only, never bytes.
- In the log, an image of a safe type (png, jpeg, gif, webp, avif) shows as
  an `<img>` from the host's URL; anything else is a download chip. Names are
  text; nothing a user sent is rendered as HTML.
- **+ → Inbox** (View group) lists the stored files, newest first, with the
  usage line at the top ("12 MB stored · 3 files"), a **Delete** per file
  (confirmed: "Delete for good?"), and the host's actions — here an Anki
  package (`.apkg`/`.colpkg`) gets **Import as a deck** (导入为卡组), which
  opens `/words/import?inbox=<id>`; the import page fetches it with the
  owner's session and opens it as if dropped (the usual import into his own
  word list). The same action shows under the line that carried the file.

**On lianki.com** (`lib/inbox/`, `app/api/dev/inbox/**`). Owner session only
(`isOwner`, 404 for anyone else, friends included, as every `/api/dev`
route); the chat passes `files` only on the owner's own pages.

| route                        | what                                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `POST /api/dev/inbox`        | raw body, `x-file-name` (URI-encoded), `content-length` required; streamed to R2 (hashed on the way) |
| `GET /api/dev/inbox`         | his files and usage (settles accrued storage cost)                                                   |
| `PATCH /api/dev/inbox`       | `{ids, line}`: the chat line they were sent with                                                     |
| `GET /api/dev/inbox/<id>`    | the file: his session, or an agent's ticket in `x-inbox-ticket`                                      |
| `DELETE /api/dev/inbox/<id>` | his own session only; the object and the row go                                                      |

- **Keys**: `inbox/<user id>/<yyyy>/<mm>/<id>` (`lib/inbox/keys.ts`); the name
  never goes into a key. D1 `inbox_item` (id, owner, name, type, size,
  sha256, created, processed, line id, ticket hash/expiry) and
  `inbox_usage` (`db/migrations/0035_inbox.sql`).
- **Sniffing** (`lib/inbox/sniff.ts`): the stored type comes from the first
  512 bytes, never the browser's claim; HTML/SVG/XML are stored as
  `text/plain`; PE/ELF/Mach-O/`#!` are flagged. An `.apkg` is a zip.
- **Serving**: `Content-Disposition: attachment` for everything but the safe
  image types, `nosniff`, `CSP: default-src 'none'; sandbox`, private cache.
  No public URL: his session, or a single-use 60 s ticket.
- **Caps** — one object, `INBOX` in `lib/inbox/config.ts`, **the owner may
  change any of them**; first values (conservative, the agent's pick):
  20 MB per file, 200 MB per rolling 24 h per user, 2 GB stored per user (a
  safety cap, not a plan limit), 30 uploads a minute per isolate.
- **Cost, by usage** (owner, 2026-11-04: "按用量扣莲（上传和存储）"):
  `lib/inbox/charge.ts` `chargeInbox`, the same seam as the AI gloss's
  `chargeAi` — it records the real R2 cost in USD (list prices in the
  config: Class A per upload, Class B per download, storage GB-month); the
  debit goes there once the credit unit is final. Storage accrues as bytes
  stored × time since `inbox_usage.settled_ms`, settled at every upload and
  delete and when he opens the Inbox view — nothing polls.
- **Retention**: none automatic. A file stays until he deletes it.

**The agent** (`bun scripts/dev/eval.ts inbox …`, with the saved grant):
`inbox` lists `{id,name,type,size,sha256,at,processedAt?,line?}`; `inbox get
<id> [--out dir]` asks the hub, which calls the main Worker's
`DebugSessions.inbox` over its service binding for a single-use ticket, then
downloads into `$TMPDIR/lianki-inbox/<id>/` and checks the sha256; `inbox
done <id>` marks it processed. `inbox rm` only says that deleting needs his
own session. Chat lines from `eval.ts chat` carry `"attachments"`.

## The state tree, live

The chat's Tree view (menu → Tree; `docs/state-tree.md`) normally shows the
copy bundled at commit time, from `GET /api/dev/state-tree`. While the widget
is hot-loaded, the same dev server also serves the working tree's
`docs/state-tree.md` at `/state-tree.md` (CORS for lianki.com) and sends a
`tree` event on `/events` whenever it is saved (`fs.watch` on `docs/`, no
polling). `DebugChatHost` then hands the chat a feed
(`pickTreeSource` / `hotTreeSource` in `debug-widget.ts`) that fetches it on
open and on each `tree` event, so an edit reaches the owner's open page in
about a second, with no commit or deploy. A green dot next to "Tree" means the
data is live; if the dev server cannot serve the file, the feed falls back to
the bundled copy and the dot is gone.

`treeSource` accepts a URL, a function returning markdown or nodes, or
`{subscribe(onUpdate) → unsubscribe}`: the WebSocket progress feed
(`feat/live-roadmap`, parked) will be another such feed.

## ETA bar

Flag `chat.eta-bar` (owner only; the root layout reads it and passes
`etaBar` down to DebugChat). Every live state-tree node with an estimate
(`progress.ts --eta 25m`, its `etaAt`; docs/state-tree.md, "ETA pings") is a
timed task (`eta.ts etaTasks`, read from the overlaid tree). Above the input,
one line (`EtaBar.tsx`): a small clock drawn in place, "Title · 25M" for
one task, or "3 tasks · 1.5H · next in 5M" for several, and the percent;
a tap opens the state tree, whose top lists each task as a Gantt row
(`EtaList`). There is no separate meter (owner, 2026-11-08): the summary
line's own background is filled from the start edge to the progress
(weighted by each estimate), blue running, red past its estimate, green done.

Time labels (owner, 2026-11-08 20:34 JST), everywhere — bar, list, minimized
line: one language-neutral form, `eta.ts compactTime`: under an hour "<n>M"
(whole minutes, rounded up), from an hour hours to one decimal ("1H", "1.5H"
for 1 h 29 min, "2.5H"; never "1h20m"); past due negative ("-5M", "-1.5H")
and drawn red (`ETA_COLORS.late`, AA on every background of a row).

The list is a Gantt chart (owner, 2026-11-08 20:24 and 2026-11-09 01:38–01:39
JST). All rows share one axis (`ganttWindow`): the left edge is the earliest
start of a shown task, the right edge the latest end (estimate, or when a done
one finished, queued tasks at their computed ends); it rescales whenever the
tasks change. A row's background is its bar (`ganttRow`): from when the work
started (the node's first "doing", `startedAt`) to its etaAt, the agent's pct
a deeper fill inside it, and past the estimate a red overrun on to now. Running
tasks overlap freely; queued ones (status waiting: for an agent slot or the
gate) run one after another in order of creation (`ganttPlan`): the first
from when the soonest running task is due (or now), each next from the end of
the one ahead, each as long as its estimate as posted. A red vertical line
marks now on every row, labelled "Now" (language-neutral) on an axis strip
under the rows, clamped to an edge outside the range; it moves with the page's
one clock. No estimate, start, end or actual numbers are drawn — only each
row's time left. Rows are full width, so it fits 360 px. The colours are
opaque `light-dark()` pairs (`ETA_COLORS`): text, the muted description and the
red at WCAG AA (4.5:1) on the track, the bar, the fill, the overrun and done,
which unit/eta.test.ts computes. Like everything in the chat, the line is dimmed with
the whole panel at rest (`opacity-60`) and full while the chat is in use.
On the owner's box it works the same (docs/box-oauth.md, "The state tree on
the owner's box").
The floating buttons above the input (scroll-down, ask jump) sit the bar's
measured height higher (`etaH`, a ResizeObserver on its slot), so they never
cover it (owner, 2026-11-08, Android); `scripts/dev/debug-chat-eta-overlap-qa.mjs`
checks it at 412×915 and 390×844, light and dark, scrolled up, in and out of
full screen.

**One glass strip** (owner, 2026-11-10): while the bar shows, it and the
input row are one bottom strip with one frosted surface. The bar's slot sits
right over the input row; a layer behind both (`data-testid="debug-chat-strip"`,
absolute inside the row's grid, reaching `etaH` up) carries the input row's
own glass (`INPUT_BG`, blur 12 px, saturate 1.5, hairline edge), the input
row drops its own (`barInGlass`), and the bar drops its track (`EtaBar glass`).
It is a layer, not a wrapper, because a backdrop-filter on an ancestor would
become the box of the fixed menus and floating lines inside the row. With no
bar the input row looks as it always did (it already wore that glass). Off
while the typing glass is the frame, and full screen. While a task is in
progress the fill shows activity: a soft light sweeps along it
(`ETA_SHIMMER_CSS`, its own keyframes since the hot widget has no app
stylesheet); none when all are done, and none under prefers-reduced-motion.

### Full-screen Gantt

A tap on the ETA bar (or ⤢ on the state tree's list) opens the Gantt full
screen (`GanttFull.tsx`, owner 2026-11-09 13:37–13:38 JST); ✕ or Escape
closes it, and the compact list in the tree stays as it is. It is portalled
out of the chat's box and fills the viewport, phone and desktop. One native
scroller: vertically through every timed task the tree has (open ones first,
then the done history, the latest first: `gantt-view.ts ganttRows`), the time
axis header sticky at its top; horizontally through time. Each row's name is
pinned at the left edge of what is visible (`position: sticky; left: 0`),
whether its bar starts far to the left or ended long before. A row's bar is
its background and see-through (`GANTT_COLORS`, oklch with alpha), so the grid
and the red Now line show through; the text is AA over every bar composited on
the panel (unit/gantt-view.test.ts composites in sRGB as the browser does).
Overdue stays red with a minus; queued bars are fainter and dashed.

The axis math (scales, ticks, bars) is our component library's gantt module,
`@snomiao/rgui/gantt` ([rgui.md](rgui.md)); `gantt-view.ts` re-exports it.
The axis (`gantt-view.ts`): x = (t − lo) · pxPerMs. On open now sits a quarter
from the left and the tasks fit the screen, but never under 120 px per hour
(`MIN_PX_PER_HOUR`): a long range scrolls. There is no hard limit either way:
within a screen of an end the range grows by two screens (`extendAxis`, the
scroll compensated when the left grows), the far side is trimmed past 12
screens, and ticks are drawn only around the view, so the DOM stays bounded.
"Now" (button) jumps back (`axisToNow`). Pinch on a phone, ctrl+wheel (a
trackpad pinch) or Safari's gesture events on a desktop zoom the time scale
about the fingers or pointer (`zoomAxis`: the time under them stays put), from
10 minutes to 14 days per screen; the page itself never zooms there
(`touch-action: pan-x pan-y`, the two-finger move prevented). Tick labels are
relative to now in the compact form, re-picked as it zooms: "-30M", "Now",
"2H", "1.5D" (`tickStep`, `axisLabel`).
**The logarithmic axis is the default** (owner, 2026-11-09 15:27 JST): a
time t is drawn at u = sign(dt) · L · ln(1 + |dt| / T) px from the Now line,
dt = t − now (`gantt-view.ts symlog`, `symexp` its inverse): linear within
about T of Now (L / T px per ms), further out every e-fold of distance takes
the same L px, past and future alike. So a 5-minute task near Now is wide and
a task two days out still fits the screen. On open T is the narrowest window
that fits the open tasks (the done history scrolls into view), at least 2
minutes, and L about an eighth of the width (24–240 px); Now sits a third from
the left. The content spans a thousand years either side of Now, which is a
few screens at most, so nothing grows or trims; Now stays at the same x while
time passes and the bars move. Each bar's start and end are projected
separately (`ganttBar` over either axis). Zoom (`zoomLogAxis`) multiplies L by
√f and divides T by √f, so near Now the scale changes by f and far out by √f;
the time under the fingers stays put. Ticks (`logTicks`) stand at round M/H/D
distances (`LOG_TICKS`): from Now outward on each side the next one whose
label box clears the last by 10 px, at the measured text size, so labels never
overlap at any zoom; the linear axis's step is also at least its longest label
wide (`tickMinPx`). A small "Linear | Log" switch (线性 | 对数) in the header
switches the axis, remembered per device (`lk:pref:gantt`, ui-store.ts
`ganttPrefs`); strings `etaGanttScale`, `etaGanttLinear`, `etaGanttLog`.
The QA script checks the log axis first (opens on it, Now a third from the
left, the 12-hour task on screen, a 45-minute task readable, no tick labels
overlapping on open, panned and zoomed, names in view, zoom anchored, Now
button), then switches to linear and runs the checks below, and checks the
choice is remembered when the Gantt opens again.

`scripts/dev/debug-chat-gantt-qa.mjs` checks it at 1440×900, 1512×770 and
390×844, light and dark: the panel fills the viewport, the axis stays at the
top after a vertical scroll, Now is in view on open, every name is in view
after panning both ways, the axis grows to the left with the DOM bounded,
zoom keeps the anchor, no horizontal page scroll.

Task titles are "name: description" (ASCII ':' or full-width '：';
`eta.ts splitTitle`): the bar and the minimized chat show the name, the list
shows the name in bold and the description muted (`ETA_COLORS.muted`, AA on
every fill too). Minimized, while any timed task is open, the in-progress line
is the two ends instead of the ≈ summary (`etaEnds`, `etaParts`): the nearest
open leaf and the open task due last, "Fill line 5M · Box ETA 1.5H"
(compactTime; red and negative past due). Each name truncates, the
nearer one first; the times never do; the full line is the title. With no
timed task the ≈ summary shows as before. The summary's progress is time
against the estimate (a done task is full and leaves after 8 s). Strings: `eta*` in
learning-partner.content.ts, each with its context line.

One timer per page (`etaClock`), armed to the soonest of an estimate, a done
task leaving, or a label's next minute (past due too, as "-1M" counts on); re-armed on every tree update; no
interval, no polling. When an estimate passes unsent, the page sends
{type:"eta", id} on the progress socket (once per estimate per page); the hub
also has its own alarm, marks the node sent and posts at most one line, so
two devices never ping twice and no page needs to be open.

## UI state across a refresh and a hot swap

The chat's session UI state is one store, `chat`, made with the shared
UI-state factory (`@lianki/ui-state`, `docs/ui-state.md`;
`packages/debug-chat/src/ui-store.ts`). It is zustand `persist` over
**sessionStorage**, under `lk:ui:chat`. It holds:

- the draft, its caret, and whether the draft is still pure dictation, so a
  restored voice line still sends as `source: "stt"`;
- whether the tree panel is open;
- the state tree's place: the focused node, the opened nodes and their
  depths, and the minimized tree's scroll.

The tree's place is kept by **title paths**, not index ids
(`tree-keep.ts` `keepTree` / `restoreTree`). A node added above it does not
move the focus, and a node that is gone falls back to its nearest ancestor.

How it is stored and restored:

- The factory's storage never throws (it falls back to memory).
- `migrateChatUi` checks every stored value (as the factory's `clean`, and
  as `migrate` for an older version), so a damaged entry falls back to the
  defaults.
- The factory keeps one store per page on `globalThis.__lkUiStores`, so a
  re-imported widget (a hot reload, or the built-in chat taking over) uses
  the same store.

Only UI state goes in it, never business data (messages, grants, tokens).
Device preferences, including the bar's position, stay in localStorage.
Not kept, on purpose:

- the log's scroll: the resting compact log always shows the newest lines;
- the full-screen log: it only lasts as long as a drag;
- the mic: it never turns itself on after a reload.

**zustand and the page's React.** zustand's `import React from "react"`
made Bun wrap the React shim as CommonJS with its ESM exports empty. So the
shim (`hostModule` in `scripts/dev/debug-widget-build.ts`) is now CommonJS
outright: `module.exports = globalThis.__lkReact.React`.

## Page audio owner: one sound at a time

Owner, 2026-11-05 03:05–03:06 JST: opening the reader's word review pauses
the paragraph being read aloud, and Li speaking pauses any reader or word
read-aloud. Each one goes on where it was once the other is done: the
reader from the same sentence, /words from the part it was saying.

Ranks, highest first (`AUDIO_PRIO`):

1. `li` (3): Li's voice-out (`voice.ts`, claimed before each sentence,
   released once nothing is speaking, after the tail). When Li speaks is not
   changed by it: `shouldSpeak` and the focus rule are the same.
2. `card` (2): a word or card read aloud. That covers /words' sequencer
   (`lib/words/sequence.ts`, so the review inside the reader as well) and the
   reader's word review while it is open (`ReaderV2.tsx`, which has no sound
   of its own and holds the page only to keep the paragraph paused).
3. `para` (1): the reader's paragraph read-aloud (`lib/read/speaker.ts`).

The widget bundle can be hot-loaded with its own copy of every module, so the
two sides share no module state. The contract is two window events
(`packages/debug-chat/src/audio-claim.ts`, used on both sides):

| event              | detail         | meaning                                                                                                                                                                                                                     |
| ------------------ | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lk:audio-claim`   | `{ id, prio }` | cancelable, "I am about to play". An owner holding or waiting with a higher `prio` calls `preventDefault()`, and the claimer waits. One holding with an equal or lower `prio` pauses and waits (the newest of equals wins). |
| `lk:audio-release` | `{ id }`       | "I am done". Each waiter claims again. A higher waiter cancels a lower one's claim, so the highest goes first.                                                                                                              |

- Only an owner that is holding or waiting listens. An idle one needs no
  cleanup.
- A waiter that leaves (stop while paused) sends no release, and cancels
  nothing on the speech engine, because that would cut Li's voice.
- A claim is made before the sound starts. The paused side is silent before
  Li's first utterance reaches `speechSynthesis`.
- Nothing polls: every change is one of these two events.

Tests use a fake audio clock and fake elements, with no sound:
`unit/audio-claim.test.ts`, `unit/read-speaker.test.ts` ("pauses for a
higher sound") and `unit/voice-session.test.ts` ("Li owns the page's audio").

## Eval tokens: code without the tap

Owner's decision by tap card, 2026-11-07. Besides the pairing (a tap on a page,
8 hours, renewed while his page is open), a sender can connect with an **eval
token**. That is an API token with the `eval` permission, which only a site
owner can make, for at most 30 days ([secrets-and-auth.md](secrets-and-auth.md),
"Eval tokens"). **Whoever holds it can run code on his open pages, lianki.com and
his box, with no tap.** Making the token is the grant.

- `LIANKI_TOKEN=lk_… bun scripts/dev/eval.ts '<code>'` (and `lianki-dev serve`)
  sends it as `Authorization: Bearer` on the control socket. The hub asks the
  main Worker (`DebugSessions.evalToken`) at connect and before every eval. Each
  use is audited (`api-token.eval`). A refusal closes the sender (4498).
- It is an eval session in the owner's thread, listed on his pages like any
  other, labelled `token <name>`. It reaches every owner page, and a box page
  only while that box holds `box:eval`. It never reaches a friend's pages.
- Revoke on the token page closes it at once. End on a page closes only that
  socket.
- Without a token the pairing flow is unchanged. A lane's chat-only
  `LIANKI_TOKEN` is refused for eval, and `eval.ts` then falls back to the saved
  grant.

## Page errors

The owner's pages report their own errors to the agent, so it can watch them
and fix them without being told (owner's order, 2026-10-31).
`packages/debug-chat/src/page-errors.ts` hooks the page, and
`app/components/DebugEval.tsx` wires it to the debug socket.

**What is caught:** window `error` and `unhandledrejection`; every
`console.error` (still logged as usual); same-origin `/api/*` fetches
answering ≥ 400 (`fetch`, e.g. `/api/words/tts` 503, `/api/debug/stt` 502)
or failing on the network (`network`; an abort is not an error);
`<audio>`/`<video>`/`<img>`/`<source>` load errors (`media`, listened for in
the capture phase on `window`); and the local STT socket closing on its own
(`socket`, reported by `local-stt.ts` through `reportPageError`).

**Who reports:** the hooks go in when the debug socket is first wanted
(debug mode on), and errors are queued (at most 10) until the hub's `state`
arrives with no `friend-status` first — the owner's page. Then the queue,
and every later error, goes over the socket. A friend's page drops its queue
and removes the hooks at `friend-status`; ordinary users never open the
socket, so never hook. The hub ignores a page-error from a friend's page
anyway. Debug mode off removes the hooks.

**Wire.** Page → hub `{type:"page-error", kind, message, stack?, path,
status?, at, rev?}` — `kind` one of error, rejection, console, fetch,
network, media, socket; `path` the page's (or the failed request's) path,
never a query; `rev` the build (`NEXT_PUBLIC_BUILD_ID`, `dev` under next
dev). The hub (`workers/push/src/debug.ts`) adds the socket's own `label`
(the page's path and user agent; a label in the message is ignored) and
`hubAt`, and sends it live to the owner-approved listeners only — not
heartbeat sockets, not a friend's preview pairing, never a page. It is never
stored. Log: `debug.page-error` (kind, path, status, first 80 characters).

**Scrubbing (on the page, before anything is kept):** emails →
`<email>`; `Bearer …`/JWTs → `<token>`; `token=`/`password:`/`cookie`/
`session`/`api_key`/`sig`… values → `<redacted>`; cookie strings →
`<cookie>`; query strings and fragments → `?…`; opaque strings of 32+
letters and digits → `<token>`. Text the user typed or said is cut out as
`<typed>`: the current values of every input, textarea and contenteditable,
and the chat's latest 50 lines (owner, friend and agent; so chat and STT
text never leave). Arguments to `console.error` that are objects are never
serialized (`[Object]`, `[Array]`); Errors become `Name: message`. Message
≤ 500 characters, stack ≤ 12 lines and 1500 characters (the hub caps the
same).

**Dedupe and rate.** The same kind + message + path is sent once per 5
minutes; at most 10 errors a minute go out (the rest are dropped, and are
not even scrubbed).

**Listening.** `eval.ts chat` prints them as `{"type":"page-error","kind",
"message","stack","path","status","label","rev","at"}` lines (and appends
them to `--out`). A dedicated watcher, printing only those:

```bash
# In the background (run_in_background); the main lane watches the file with Monitor.
bun scripts/dev/eval.ts errors --no-pair --out /tmp/lianki-page-errors.jsonl
```

It holds the saved chat grant like `chat` (same reconnects, no polling);
`--no-pair` never asks the owner — with no grant it prints
`{"type":"error"}` and waits for one to be saved.

## Testing

`bun test unit/debug-widget.test.ts` covers the URL rules, the module checks,
the React stubs and a real build. That build must hold no React of its own,
must export `DebugChat`, and must ship CSS and a stable rev.

The debug chat cannot show in local QA, because the page's socket goes to
lianki-push, which `wrangler dev` does not run. The loader is therefore tested
end to end on `/harness`, which renders the real `DebugChatHost` with made-up
messages. It shows every kind of avatar: the agent's (an element, the
liagent mark, standing in for the host's logo), the viewer's picture, and
two friends' initials (one picture that fails to load, one with none);
`?nopic=1` drops the viewer's picture, so their lines show the initial too.
It also shows node-path lines: two nodes' agents, one agent addressing
another, and the owner's line to a node. Typing `@/` there offers its nodes,
and `?target=/words/prefetch` starts with that chip.
Run it by hand with Playwright: open `http://localhost:5180/harness`
(`?working=1` shows the spinner) and set the localStorage key to
`http://localhost:5180/debug-chat.js`. Then check `[data-debug-widget]` (its
value is the rev) and edit `DebugChat.tsx`: the rev changes and the new UI
renders. `?min` (or `?open`) starts minimized (or expanded), `?notree` and
`?nofrontier` leave out the static tree and frontier, and
`globalThis.__push(text)` adds a live message.

`bun scripts/dev/debug-chat-bar-qa.mjs [--shots <dir>]` does that on its
own: it starts the server on a free port, loads the hot widget into
`/harness`, and checks the chat bar expanded and minimized (one container,
focus order, 16px input, 40px targets (44 px since the mic joined the cluster), the inert input, the mic clickable and
its drag gestures, floating lines). getUserMedia is stubbed, so nothing is
recorded. `--shots` also saves light/dark × expanded/minimized at 390px.

The bar's round corner controls are concentric with its border by
construction (`bar-geometry.ts`): the nested-radius rule, inner radius =
outer radius − (border + padding), as Apple's iOS 26 `ConcentricRectangle`
does. The bar's radius is `--lk-bar-r = border + padding + line/2`. Folded,
the mic is the pill's last control and its circle is the line-sized square in
the inner bottom-right, so the pill's right end is a semicircle around the
mic; open, the same circle sits beside the input on the bottom line (see "The
mic keeps its place" below), and a taller draft keeps the controls on the
bottom line. Text size does not scale it (only
text scales). The geometry is inline styles, never new Tailwind classes: a
stylesheet that has not generated a new class (the whole-page dev server's
stale CSS on 2026-11-03) left the bar with no radius and no border. `bun scripts/dev/debug-chat-concentric-qa.mjs [--shots <dir>]`
measures both centres (getBoundingClientRect) at 390×844 and 412×915, light
and dark, one line, four lines, text at 150% and minimized, and fails over
0.5px. A control added in a corner (a + at the left end) takes its circle
from the same variables.

### The mic keeps its place

Owner, 2026-11-07 19:27 JST: "我们把麦克风跟另外几个按钮排到一起吧……这样折叠的时候，它位置就不会变".
The mic is in one cluster with the chat's other buttons: `[mark | + | mic |
input]` open, `[mark | Li | mic]` folded, the pill's Li in the +'s slot. Every
slot is `CONTROL_W` (44 px) and the bar's padding is the same folded and open
(`bar-geometry.ts`), and the fold keeps the mark where it was, so the mic does
not move as the chat folds. Full screen spans the bar across the screen
(owner, 2026-11-07 20:30 JST; see "Full screen"): the mic keeps its height
and its offset in the bar (the bottom pad includes `--lk-bottom-reserve`, as
the panel rests above it) and moves sideways only to where the bar now starts,
the panel's own 8 px gutter. The cluster's touch areas
are 44 px each way (`TAP_44_CSS`, a `<style>` of the bar's own, so another
site's page has it too). The up-arrow and scroll-down sit over the bar's other
end and never cover the mic.

Where it still moves, and why:

- **A panel dragged up the screen** (`lk:debug-chat-pos` with a y offset): in
  full screen the bar goes to the bottom, as the log fills the screen above it.
- **Restoring a pill dragged near the right edge**: the open bar is wider, and
  `fit` slides the box back on screen, so the cluster shifts with it.
- **Entering full screen**: the bar spans the screen, so the mic goes left to
  the 8 px gutter: measured, 78 px at 414, 54 px at 390, none at 320 (the
  panel already spans it), and 72.6 px into the sidebar at 1280 (it starts at
  the sidebar's left). From a panel dragged sideways it lands at that same
  place; the way back returns it to the panel's.
- **The keyboard**: the panel lifts by `--lk-kb-lift` and full screen follows
  the visual viewport; both put the bar above the keyboard, but only emulation
  has checked that they agree.

`bun scripts/dev/debug-chat-mic-place-qa.mjs [--shots <dir>]` measures the mic's
rect at rest, typing, scrolled up with the up-arrow and scroll-down, back
from full screen, folded by the mark, open again by the Li, and back to a
panel dragged sideways, and fails on a move over 0.5 px; in full screen it
checks the mic at the bar's start, the bar's width and the grip, at 414×848,
390×844, 320×568 and 1280×800, Chromium and WebKit, light and dark.

`bun scripts/dev/debug-chat-scroll-qa.mjs` checks the log's scroll on an
Android-sized touch viewport (412×915). A drag on the empty input scrolls
the log 1:1 with the finger. A log at its end stays there through drags,
box moves and the keyboard, and lands back on the newest line on release
while that line is still in view. A log he scrolled up keeps the lines he
was reading. On fold-back the line kept is the one at the resting log's own
place, not the tall view's centre: keeping the centre was the 2026-11-03
jump to old chat. `unit/chat-scroll-pin.test.ts` covers the pure rules in
`log-surface.ts`.

## Screenshots

`scripts/dev/shot.ts` takes a PNG of the owner's open debug pages (the PWA on
the phone, say) over the eval channel, and prints the path:

```bash
bun scripts/dev/shot.ts                          # every open debug page
bun scripts/dev/shot.ts --target iPhone          # or Android, /words, any part of the label
bun scripts/dev/shot.ts --out /tmp/words.png     # a file, or a directory
bun scripts/dev/shot.ts --burst 5 --every 400    # 5 shots, 400 ms apart, by the page's clock
bun scripts/dev/shot.ts --selector "main ul"     # one element instead of the viewport
```

It needs a **live eval grant**. It resumes the saved one
(`.debug-eval-token.json`, as `eval.ts` does), so under a live grant there is
no prompt. With none, it pairs once, which prompts the owner; `--no-pair`
fails instead. Paths go to stdout, one per line, and timings go to stderr. The
default folder is `.shots/` at the repo root, which is gitignored. A burst
adds `-<n>` to the name, and every page after the first adds `-p<n>`.

**On the page.** The code (`scripts/dev/shot-page.ts`) imports
`modern-screenshot`, pinned in `scripts/dev/shot-lib.ts`, from jsDelivr once
and keeps it on `window`. It then renders the DOM through an SVG
`foreignObject` onto a canvas at the device pixel ratio, capped at 2. It
renders the whole layout viewport, so the safe-area insets are in it, at the
document's scroll offset, and inner scrollers keep theirs. It crops to the
visual viewport and fills in the page background. An image it cannot fetch
(cross-origin without CORS, or gone) is left blank instead of failing the
shot. Each PNG goes back with `$lk.send` in 128 K-character chunks, which
the CLI joins and writes as they arrive. With `--burst`, the page's own timer
spaces the shots (`burst` in `shot-lib.ts`). A slow shot delays the next one,
never overlaps it.

**Speed, measured locally.** These were measured with Playwright Chromium on a
Mac (iPhone 13 emulation, 390×664, rendered at 2×), against the real
`DebugHub` behind a local Bun server:

| Shot                             | Render on the page | Command, end to end |
| -------------------------------- | ------------------ | ------------------- |
| simple page, 75 KB PNG           | 80–120 ms          | 110–200 ms          |
| full-screen noise, 2.6 MB PNG    | 150–165 ms         | 190–255 ms          |
| first shot on a page (CDN fetch) | +45–55 ms import   |                     |

A burst of 3 every 500 ms took 1.1–1.2 s. A real phone has not been
measured: no test runs against the owner's devices. On one, add the network
(the resume handshake and the PNG upload) and a slower renderer. The aim is
2–3 s a shot.

**Limits.** DOM-to-image is a re-render, not a capture of the screen pixels,
so these may come out wrong:

- `<canvas>` and `<video>`: only their current frame, and only when it is readable.
- Cross-origin `<iframe>`s: blank.
- `backdrop-filter`: not applied, so glass bars show the content sharp behind them.
- Cross-origin images without CORS: blank.
- Fonts that are not reachable: fall back.

The browser's own UI (the status bar, the keyboard) is never in the shot.

**Deploys.** The page needs `$lk` (DebugEval) and the hub needs to forward
`chunk` messages (lianki-push). Both ship with `main`. A page from before them
answers that it needs a deploy and a reload.

## Voice clips and the STT bench

To pick a speech-to-text model on the owner's own voice, the dev server can
keep the mic's utterances on this machine, and `stt-bench.ts` can replay them
through every model. Nothing is kept unless the owner turns it on. The clips
stay in a local folder and never go into the repo or onto the Worker.
`/api/debug/stt` and the models are in [workers-ai.md](workers-ai.md),
"Speech to text".

**The sink** (`scripts/dev/clip-sink.ts`, mounted by the dev server):

```bash
bun scripts/dev/debug-widget-server.ts --port 5180 --tailnet /lianki-widget [--clips-dir <dir>]
```

The folder is `--clips-dir`, else `LIANKI_CLIPS_DIR`, else
`lianki-voice-clips` in the home directory.

| Request                      | Does                                                                                                                                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /clips`                | multipart: `audio` (the blob) and `meta` (JSON `{at?, mime?, durationMs, label, transcript, model?}`). Saves `<ISO time>-<seq>.<ext>` and a `.json` sidecar with the same fields. Answers `{name}`. |
| `GET /clips/index.json`      | `{clips: [{name, file, at, mime, durationMs, label, transcript, ref?}]}`, oldest first                                                                                                              |
| `GET /clips/<file>`          | one clip's audio                                                                                                                                                                                    |
| `POST /clips/bench?run=<id>` | the bench's raw results, written once as `bench-raw-<id>.json`                                                                                                                                      |

A clip is at most 5 MB, and webm, ogg, m4a, wav or mp3. Cross-origin
requests are allowed from `https://lianki.com`, plus each exact https origin
listed in `LIANKI_DEV_ORIGINS` or `LIANKI_CLIPS_ORIGINS` (comma-separated, no
wildcards: the whole-page dev server's `https://<mac>.<tailnet>.ts.net:8443`,
a widget preview origin). The answer echoes that origin, with
`Access-Control-Allow-Private-Network`. Any other `Origin` gets 403. Nothing
deletes a clip: the sink has no delete route and nothing cleans up. Ask the
owner before removing any.

**Keys.** An allowed origin is not enough. Every request carries
`authorization: Bearer <key>`, with one of two random keys in
`~/.config/lianki/clip-sink-keys.json` (0600, made on first use;
`LIANKI_CLIP_SINK_KEYS` overrides the path). The **write** key is for
`POST /clips`. `eval.ts clips on` hands it to the hub, which gives it only
to the owner's pages of a recording session. The **read** key is for
`GET /clips/*` and `POST /clips/bench`, and only the agent and `stt-bench.ts`
use it (it travels to the page inside the bench's eval code). A request
without the right key gets 401: another account's page on lianki.com, or a
client with no Origin, can neither read nor add.

### Recording: a window session held by the hub

Owner, 2026-10-31: the switch is not in any origin's storage, and it follows
the window across URLs and origins (lianki.com, the :8443 dev server, the
widget previews). It is session-scoped, like sessionStorage. The rules are in
`packages/debug-chat/src/clips.ts`, the hub's side in `workers/push/src/debug.ts`
("Voice-clip recording"), the page's in `clips-store.ts` (zustand, through
`@lianki/ui-state`) and `ClipsBadge.tsx`.

- **Ids.** Each window has a session id in sessionStorage (`lk:ui:clips`).
  Each origin has a device id in localStorage (`lk:pref:clips-device`). The
  first page on an origin makes one. When the hub puts a page in an existing
  session, its answer carries that session's device id, and the page keeps
  it. The page sends both on its hub socket (`?ws=&dev=`).
- **The hub keeps** `clips:<sid>` only while recording: device, since,
  optional auto-stop, sink and its write key, the owner's origins, the hash
  of a one-time handoff token, and since when no page has been connected. It
  also keeps `clipsink`, the sink the agent last set up, so that a tap can
  reuse it. Every page of the session hears `{type:"clips", sid, device, on,
until?, left?, sink?, sinkKey?, origins?, handoff?, paused?, resumable?,
canStart?}` on connect and on each change.
- **Across origins.** The session moves only between the owner's origins,
  matched exactly: lianki.com plus the list `eval.ts clips on` passes. That
  list is the sink's own allowlist (`LIANKI_DEV_ORIGINS`,
  `LIANKI_CLIPS_ORIGINS`), or `--origins a,b`. Any other host never sees the
  token, including another person's tailnet host or another port. A tap on a
  link to one of these origins gets `?lkws=<token>` added as it is followed. The new page takes it out of the address bar and knocks with
  `&hand=<token>`, and the hub puts it in the same session. The token works
  once and rotates on every join. `__lkClips.go(url)` does the same from
  eval. An address typed by hand carries no token: the page of the same
  device continues a session that just lost its page; on another device it
  is only offered ("Continue recording", a tap).
- **When it ends.** Stop on the badge, the agent's `clips off`, the optional
  auto-stop, or no page of the session for `CLIPS_GONE_MS` (2 min: a closed
  window). A page reports `hidden` (screen off, app in the background)
  before its socket drops, and `leaving` on pagehide. A hidden session lasts
  `CLIPS_HIDDEN_MS` (12 h). When the screen comes back, the same document
  says so (`cont=1`: it was recording when its socket dropped, and it never
  went through pagehide), and recording resumes with no tap. The badge then
  shows "paused N min" for a minute. Other pages rejoin silently only after a
  quick reload or navigation (not hidden, within 2 min). That excludes a tab
  closed while hidden and restored later, and a page back from the bfcache:
  a document that went through pagehide knocks with `back=1`, and the hub
  never joins it by itself, not even within those 2 min. Those pages are
  offered "Continue recording" and need a tap.
- **Stop is local first.** A tap on Stop turns recording off on the page at
  once (`stopPending`, kept in sessionStorage), whether or not the hub can be
  told. Each clip checks at send time that its session still records. The
  page sends `clips-off` again on every reconnect, and a hub state saying
  that same recording (same `since`) is on never turns it back on. Only a new
  tap, or a new `clips on` from the agent, does.
- **Wake lock.** While recording and visible, the page holds
  `navigator.wakeLock.request("screen")` ("Screen kept on" on the badge). It
  asks again when the page is visible after the system dropped it, and
  releases it when recording stops. Without the API, the badge says it
  pauses when the screen sleeps.
- **The badge** ("录音中 / Recording") is a glass pill at the top of every
  page of the session, with a one-tap Stop. It always shows how many clips
  the sink acknowledged. A failed post turns it to "Saving failed" in red,
  and the page logs `clip-post-failed` (status and sink host only, never
  audio or text) to `/api/dev/log`.
- **The sink URL has one source**: the hub. `eval.ts clips on` sets it,
  defaulting to `https://<this Mac's tailnet>/lianki-widget`, and checks
  first that it answers with the read key. A tap in the menu reuses the
  sink the agent last set up; the menu item shows only when there is one
  (`canStart`). No origin's localStorage key is read any more, so a stale
  `lk:agent-clip-sink` cannot win (it once sent every clip to a dead host).
- **On and off.** The agent: `bun scripts/dev/eval.ts clips` (list),
  `clips on --device <text> [--minutes N] [--sink <url>]`, `clips off
[--device <text>]`. `<text>` matches a session or device id prefix, or text
  in a page label ("Android"). The page: the chat menu's "Record voice clips"
  (with an "Auto-stop after 60 min" switch, off by default), and Stop on the
  badge. Turning it on is always a tap or the agent, never the voice.
- **Off the critical path.** The upload is built and sent in a later task,
  after the mic has its final transcript (`mic.ts sideClip`). It never delays
  recognition, and the VAD never waits on it. `unit/clips-session.test.ts`
  measures this: 20 utterances with a 200 ms sink take no longer than with no
  sink.

**Reference text.** To score a clip, put what was really said in
`<name>.ref.txt` next to it. The bench then adds a CER for each model.

**The bench** runs on the owner's debug page through `eval.ts`, so it uses
the owner's session and the owner's `?model=` override:

```bash
bun scripts/dev/eval.ts serve &   # pair once (or approve the prompt it shows)
bun scripts/dev/stt-bench.ts --sink https://<machine>.<tailnet>.ts.net/lianki-widget \
  [--models @cf/openai/whisper-large-v3-turbo,@cf/deepgram/nova-3] [--target /words] [--clips-dir <dir>]
```

The page fetches each clip from the sink and POSTs it to
`/api/debug/stt?model=<m>` once per model. It then posts the raw
`{clip, model, text, ms, language?, error?}` list back to the sink, because an
eval answer is too small for it and the run outlives eval's 20 s wait. The
script watches the folder for that file, so it waits on an event instead of
polling. It then writes `bench-<time>.json` and `bench-<time>.md` there.

The markdown has two tables. The first has one row per model: runs, errors,
mean latency, mean CER (over clips with a `.ref.txt`), mean agreement with the
other models (1 − normalised edit distance), USD per audio minute, and what
the run cost. The second is clip × model, with each transcript, its latency
and its CER. Scoring ignores case, width, spaces and punctuation
(`scripts/dev/stt-bench-lib.ts`, tested in `unit/stt-bench.test.ts`).
