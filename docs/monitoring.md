# Monitoring and alerts

`lianki-monitor` (`workers/monitor`) watches the `lianki` Worker and posts to
Slack #lianki. Deployed by `deploy-worker.yml` before the main Worker, which
names it as its tail consumer.

**Event-driven only — no cron, no polling** (an owner rule for the whole
system). It acts on the tail event of every real request: wall/CPU time,
status and outcome go to Analytics Engine, and it alerts on ≥3 errors or ≥5
requests over 5 s within 10 minutes. On a later request, once 10 minutes have
passed with none, it says the burst is over. The flip side: with no traffic
there are no events, so a site nobody is visiting raises nothing.

Thresholds live in `workers/monitor/src/rules.ts` (unit-tested). An alert
repeats at most every 30 minutes (KV `lianki-monitor-state`).

**Slack.** Set one secret on `lianki-monitor` (dashboard → Workers →
lianki-monitor → Settings → Variables and secrets, or `wrangler secret put
-c workers/monitor/wrangler.jsonc`): `SLACK_WEBHOOK_URL` (an incoming webhook
for #lianki), or `SLACK_BOT_TOKEN` (the bot must be in #lianki). Without one,
alerts are only logged (`monitor.alert` in the Worker's logs).

**Metrics.** Analytics Engine dataset `lianki_metrics`: `index1` is `req`; blobs are kind, path, status, outcome/error, method; doubles are
wall ms and CPU ms. Query with the SQL API, e.g.

```sql
SELECT blob2 AS path, quantileWeighted(0.95)(double1, _sample_interval) AS p95_ms, count() AS n
FROM lianki_metrics WHERE index1 = 'req' AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY path ORDER BY n DESC
```

## New-version push (`lianki-push`)

`workers/push`: one Durable Object holds every open page's WebSocket
(`/api/version/ws`, hibernation API — idle sockets cost nothing). The first
request a new isolate of the main Worker serves announces its build id over
the `PUSH` service binding (`lib/announce-build.ts`); a new id is stored and
pushed to every page, which then shows "New version · Refresh". No CI step,
no secret, no timer. Pages connect only while visible and focused, and get
the current build on connect. `/api/version/stream` answers pages from the
old SSE design once with "new version" and asks them not to reconnect.

**Deploying `lianki-push`** is manual (`bunx wrangler deploy -c
workers/push/wrangler.jsonc` with an account that may edit the zone's
Workers routes): CI's token cannot, and a failing step there skipped the main
Worker's deploy. The main Worker's `PUSH` binding only needs it to exist.
Its own `MAIN` binding (to `lianki`, for the remote-eval owner check below)
needs the main Worker deployed first when that check changes.

## Remote eval (owner debug)

Lets an agent run JavaScript in the owner's own debug-mode pages (the
installed iOS app on /words, say) and read what comes back — with the owner
approving each sender on the device. Pieces: `workers/push/src/debug.ts`
(the hub, Durable Object `DebugHub`), `app/components/DebugEval.tsx` (the
page), `scripts/dev/eval.ts` (the sender), `lib/dev-eval.ts` (shared rules).

**Receiving side — the owner's pages.** A page opens
`wss://lianki.com/api/version/debug` only while this device is in debug
mode (`?debug=1` on any page, or seven quick taps on /words' Settings button; `lk:debug`
in localStorage) and the page is visible. lianki-push accepts the socket only
if its Origin is `https://lianki.com` and the main Worker, asked over the
`MAIN` service binding with the page's Cookie header, answers
`/api/dev/whoami` with 200 — that is, `isOwner()` on the session. Anyone
else gets 403, and `/api/dev/whoami` itself is a 404 for them. A page not in
debug mode never connects; a refused one does not retry until the next
visibility or debug event.

**Sending side — pairing, no stored secret.** The sender opens
`wss://lianki.com/api/version/debug/control?label=…` with no credentials
(a browser can't: any `Origin` header is refused). It can do nothing until
the owner answers the prompt that appears on every open debug page:
"<label> wants to run code on your debug pages", with a 4-hex code the
sender prints too. **Allow for 1 hour** approves that one socket; **Deny**,
the session pill's **End**, the hour running out, or the socket closing ends
it. One pairing may wait at a time (2 minutes at most), so prompts cannot be
spammed; with no debug page open the sender is turned away at once.

**Running.** The approved sender sends `{type:"eval", code, target?}`; the
hub gives it an id and passes `{id, code}` to each page whose label (path,
`pwa` when installed, user agent) contains `target`. The page shows "debug
eval ran · id", runs it as `new Function` in an async wrapper (an expression
is returned; a body may `return`; `await` works), and sends the result — a
JSON summary of at most 4 KB, or the error and stack — back over the socket
to the sender and to `/api/dev/log`. The app sets no Content-Security-Policy,
so nothing blocks `new Function`.

**Logs.** Every pairing, answer and command (id, length, first 200 chars) is
logged by lianki-push (`wrangler tail lianki-push`, `debug.*`); results land
in the main Worker's (`wrangler tail lianki`, `dev.client` with
`ev: "eval-result"`).

```bash
# Pair once and keep the session (run it in the background); approve the
# printed code on the device.
bun scripts/dev/eval.ts serve --label "lianki main lane on $(hostname -s)"

# Then, as often as needed for the next hour:
bun scripts/dev/eval.ts 'document.title'
bun scripts/dev/eval.ts --target iPhone 'return [location.href, innerWidth, innerHeight]'
echo 'localStorage.length' | bun scripts/dev/eval.ts -
```

Without a running `serve`, each command pairs for itself (one prompt per
command). The session's local port and a random token are kept in
`~/.config/lianki/eval-session.json` (mode 600) while `serve` runs.

### Chat with the agent

Every owner page that holds the debug socket also shows a small chat box at
the bottom right (`app/components/DebugChat.tsx`; collapsed to a pill by
default on /words). The owner types; the text goes out 3 s after the last
keystroke (a thin bar drains while it waits), or at once on Enter
(Shift+Enter is a newline) or when dictation drops in over 10 characters
ending a sentence (。 . ! ?). The box is translucent until touched. Nothing is sent in the middle of an IME
composition. The header shows "agent listening (n)" — the approved senders
connected now. Agent replies are read aloud with `speechSynthesis` (the
language is guessed from the script: kana → ja, Hangul → ko, other Han →
zh-CN, else en), one after another; typing cancels what is being read, and
the speaker button turns it off for the device (`lk:debug-chat-speak`). Only
replies arriving live are read, never the history. iOS needs a gesture
first: the first tap or key inside the box unlocks speech.

**Wire.** Page → hub `{type:"chat", id, text}` (text ≤ 4000 chars); sender →
hub `{type:"say", text}`, acknowledged with `{type:"said", id}`. The hub
stores each as `{id, from:"owner"|"agent", label, text, at}` — the last 200,
one Durable Object storage key each (`msg:<seq>`) — and broadcasts
`{type:"chat", message}` to every page and every approved sender. A page
gets `{type:"history", messages}` on connect, a sender on approval, so a
reload, a second device or a reconnecting listener sees what it missed.

**Scopes.** The pairing prompt has two answers. **Allow for 1 hour** = eval
and chat on that socket. **Allow chat for 30 days** = chat only: the sender
hears the owner's messages and may `say`, but an eval is refused. It is the
one that survives reconnects: the hub hands the sender a random 256-bit
**grant token** once, and keeps only its SHA-256 (`grant:<hash>` →
`{label, until}`). A sender that connects with the header `x-debug-token:
<token>` is back in chat scope without a prompt (even with no page open)
until the grant expires; a wrong or lapsed token is closed with 4498. The CLI
keeps the token in `.debug-chat-token.json` at the root of the main checkout
(gitignored, mode 600; `LIANKI_CHAT_TOKEN_FILE` overrides). **End** on the
session pill deletes the grant and closes every socket using it; the
listener then exits and forgets the token. A grant whose listener is offline
has no pill: it lapses after 30 days, or ends at once by deleting the file
— or reconnect and End it.

**Logs.** `debug.chat` (owner message: page, length, first 80 chars),
`debug.say` (agent reply: sender, length, first 80 chars), `debug.resume`
(a grant used to reconnect), in `wrangler tail lianki-push`.

```bash
# Listen (in the background): one JSON line per new owner message on stdout
# — {"type":"chat","id","text","at","label"} — also appended to --out. The
# first time it prints {"type":"pending","code"}: tap "Allow chat for 30 days".
bun scripts/dev/eval.ts chat --label "agent on $(hostname -s)" --out /tmp/lianki-chat.jsonl

# Reply (uses the saved grant; exits once the hub has it):
bun scripts/dev/eval.ts say "On it — fixing the swipe now."
echo "multi-line reply" | bun scripts/dev/eval.ts say -
```

The listener reconnects whenever its socket closes, backing off from 1 s to
a minute; no timer touches the network otherwise.

Fallback, if lianki-push is down: run code in a desktop lianki.com tab of
the owner's Chrome with `rech eval` — it reaches only that tab, not the phone.
