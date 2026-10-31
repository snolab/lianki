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
| `log-surface.ts`                                         | the log's display, shared by the log and the state tree  |
| `Frontier.tsx`, `frontier-view.ts`                       | minimized: the ✓ ▶ › frontier lines and their rules      |
| `DebugChatHost.tsx`                                      | the page's loader: import, re-import on reload, fallback |
| `DebugPairModal.tsx`                                     | the pairing modal                                        |
| `MicButton.tsx`, `mic.ts`                                | the mic: VAD, STT client, dictation rules                |
| `latency.ts`                                             | voice → reply timing per line (monitoring.md)            |
| `debug-widget.ts`                                        | shared rules: allowed URLs, cache-busting, module checks |
| `debug-chat-tabs.ts`, `tap-gesture.ts`                   | one voice per device; taps and drags                     |
| `wire.ts`, `icons.tsx`, `LiagentMark.tsx`                | wire types and helpers; icons; the liagent mark          |
| `Avatar.tsx`, `avatar-rules.ts`                          | the log's avatars: the component; its pure rules         |
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

Then, on the owner's page in debug mode, run this once in the console, or
with `bun scripts/dev/eval.ts`:

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
fails with the rule it broke. Polish, then reply: correct misheard words,
names and punctuation only — never change what the owner meant.

**The rules** (`DebugHub.edit` in `workers/push/src/debug.ts`, each one unit-tested
in `unit/debug-hub.test.ts`). `{type:"edit", id, text}` is accepted only if:

- the sender holds a live owner grant (chat, or eval, which implies chat); a
  pairing made for a friend never may;
- the target is the owner's **latest** line in the owner thread (agent replies
  after it do not count; any earlier line is refused);
- that line has `source: "stt"`;
- it was polished fewer than `MAX_EDITS` (3) times, and the text changes.

Friends' threads and lines can never be edited. On success the stored line
keeps the first STT text as `raw` (only the first), takes the polished
`text`, and gets `edited: {at, by, count}` (`by` = the agent id, else the
controller's label). Pages and listeners hear `{type:"edited", …}`.

**On the page.** The line changes in place (a floating line too) and is
never read aloud again. A small muted sparkle after it marks it polished
(tooltip "Polished", zh 已润色; long press on touch shows it). A tap shows
the raw STT text, muted; another tap goes back. The icon is one slot:
`POLISHED_ICON` in `packages/debug-chat/src/icons.tsx`, or the widget's
`polishedIcon` prop.

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

## Quiet lines and quiet hours

Agent lines must not wake the owner (owner, 2026-10-31). Every agent line is
shown; what changes is whether it is also read aloud.

**Which `say` to use** (agents, read this):

| Line                                                                     | Command                   | Read aloud                                   |
| ------------------------------------------------------------------------ | ------------------------- | -------------------------------------------- |
| FYI, progress, "deployed", "PR opened", deploy notices, anything unasked | `eval.ts say --quiet "…"` | never                                        |
| the answer to what he just said or asked                                 | `eval.ts say "…"`         | yes, but not in his quiet hours              |
| urgent, or it needs his confirmation now                                 | `eval.ts say --loud "…"`  | yes, even in quiet hours, unless he muted it |
| an ask card (approval needed; `eval.ts ask`, PR #384)                    | `eval.ts ask …`           | counts as loud                               |

Default to `--quiet` whenever the line is not a reply to him. `--loud` is
rare: something broke in production, or a decision blocks you and he is
expected to be awake for it. `--quiet` and `--loud` together are refused.

**Wire.** `{type:"say", text, quiet?: true, loud?: true}`. The hub
(`parseControllerMessage` in `lib/dev-eval.ts`) keeps each only as boolean
`true`, drops anything else, and keeps only `loud` when both are sent. It
copies them onto the `ChatMessage`, so pages get them live and in history,
and logs them in `debug.say`. An older hub drops them, and the line is read
as a plain `say`.

**On the page** (`packages/debug-chat/src/quiet-hours.ts`, gated in
`voice.ts` `gateVoice`). In order:

1. **Hidden page or locked screen** (`document.visibilityState` "hidden"):
   never spoken, not even a loud line. Hiding the page also stops a reading
   under way.
2. **Loud** (`loud: true`, or a line with an `ask`): read by the usual rules
   (mic on, or the speaker toggle on and the input focused). His mute (the
   speaker toggle, with the mic off) still silences it.
3. **Quiet** (`quiet: true`): never spoken, even with the mic on.
4. **Quiet hours**: nothing else is spoken. A device-local setting,
   `lk:agent-quiet-hours` = `{on, from, to}`, default on, 23:00–08:00 in the
   device's own time zone; a window whose end is before its start wraps past
   midnight. Never synced (docs/prefs-sync.md): his phone and his Mac may
   keep different hours. It is set on /words → Settings, debug mode only
   ("Quiet hours", From, To).

A line kept silent is logged as `{ev:"voice-silent", why}` (hidden, quiet,
quiet-hours) on the voice session's log. Lines carry `data-volume="quiet"` or
`"loud"` in the log, for tests; they look the same.

**Hot-loadable.** The gate wraps `reply` on the shared voice session
(`globalThis.__lkVoice`), so a hot-loaded widget applies quiet hours and the
hidden rule even under a deployed DebugEval that still calls
`speakReply(text)` without the line. Quiet and loud need both the hub
change (lianki-push) and the DebugEval that passes the line
(`speakReply(m.text, m)`); until then every line is treated as plain.

Tests: `unit/quiet-hours.test.ts` (the window, past midnight; the setting;
the order above; the gate), `unit/debug-hub.test.ts` ("say --quiet / --loud"),
`unit/dev-eval.test.ts`, `unit/node-args.test.ts`.

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

`node scripts/dev/debug-chat-bar-qa.mjs [--shots <dir>]` does that on its
own: it starts the server on a free port, loads the hot widget into
`/harness`, and checks the chat bar expanded and minimized (one container,
focus order, 16px input, 40px targets, the inert input, the mic clickable and
its drag gestures, floating lines). getUserMedia is stubbed, so nothing is
recorded. `--shots` also saves light/dark × expanded/minimized at 390px.

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
