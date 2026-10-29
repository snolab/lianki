# Hot-loading the debug chat widget

See a change to the debug chat box (`packages/debug-chat/src/DebugChat.tsx`) live on
the owner's phone, seconds after saving and without merge or deploy. The page
stays on lianki.com, so the debug socket, the chat history and the owner's
data all keep working. Only the widget module comes from your machine.

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
| `debug-widget.ts`                                        | shared rules: allowed URLs, cache-busting, module checks |
| `debug-chat-tabs.ts`, `tap-gesture.ts`                   | one voice per device; taps and drags                     |
| `wire.ts`, `icons.tsx`, `LiagentMark.tsx`                | wire types and helpers; icons; the liagent mark          |
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

## Testing

`bun test unit/debug-widget.test.ts` covers the URL rules, the module checks,
the React stubs and a real build. That build must hold no React of its own,
must export `DebugChat`, and must ship CSS and a stable rev.

The debug chat cannot show in local QA, because the page's socket goes to
lianki-push, which `wrangler dev` does not run. The loader is therefore tested
end to end on `/harness`, which renders the real `DebugChatHost` with made-up
messages. Run it by hand with Playwright: open `http://localhost:5180/harness`
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
requests are allowed from `https://lianki.com` only (with
`Access-Control-Allow-Private-Network`). Any other `Origin` gets 403.

The page posts to the sink only when the owner has set
`localStorage["lk:debug-clip-sink"]` to the server's origin, e.g.
`https://<machine>.<tailnet>.ts.net/lianki-widget`.

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
