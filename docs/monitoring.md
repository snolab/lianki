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

**Deploying `lianki-push`**: CI deploys it after the monitor and before the
main Worker (`.github/workflows/deploy-worker.yml`). Its zone route needs the
CI token (`lianki-deploy`) to hold Zone · Workers Routes · Edit on lianki.com,
granted 2026-10-29; without it the step fails and skips the main deploy (as
in #240–#242). By hand: `bunx wrangler deploy -c workers/push/wrangler.jsonc`.
The main Worker's `PUSH` binding only needs it to exist.
Its own `MAIN` binding (to `lianki`, for the debug socket's identity check
below) does not care which deploys first: when `/api/debug/identity` answers 404
(a main Worker from before friends), lianki-push falls back to the old
owner-only `/api/dev/whoami`, so the owner's pages keep connecting and
friends are refused until the new main Worker is live. Any other failure
still refuses the socket.

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
`/api/debug/identity` with `{userId, email, owner}` (`owner` is `isOwner()`
on the session). A guest gets 401 there and 403 on the socket. lianki-push
passes who it is to the hub in `x-debug-*` headers it sets itself (a page's
own are overwritten, a sender's dropped). Signed-in non-owners are
**friends** (below): their own chat thread, nothing of the owner's.
`/api/dev/whoami` stays the owner-only check (a 404 for anyone else). A page
not in debug mode never connects; a refused one, or one the hub closed on
purpose (4xxx), does not retry until the next visibility or debug event.

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
stores each as `{id, from:"owner"|"friend"|"agent", label, text, at, thread, email?}` — the last 200 per thread (Friends, below),
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

### Friends

The owner opened the debug chat to friends ("开放给朋友调试用"): any
signed-in user can put a device in debug mode (`?debug=1`, or seven taps on
/words' Settings) and chat with the agent right away — no approval step.
Pieces: the same hub, page and CLI, plus `app/api/debug/identity`, the
owner's `/dev/friends` page and `app/api/dev/friends` (→ lianki-push
`/internal/friends` over the `PUSH` binding).

**Threads.** History is per thread: `owner` for the owner's pages (kept at
the old `msg:<seq>` keys, so nothing was lost), the user id for each friend
(`t:<userId>:msg:<seq>`). Each keeps the last 200. A friend's page gets only
its own thread — history on connect and new messages — never the owner's
or another friend's; the owner's pages get only the owner thread. The
agent's listener (an owner-approved chat grant) hears every thread: each
line carries `thread`, `email` and `label` — the page's path plus user
agent, so the agent knows which page a friend means. A friend's first
message ever also sends the listener `{type:"friend-new", userId, email}`;
the agent tells the owner in Slack.

**Limits.** A friend may send 30 messages per 10 minutes; past that the hub
drops the message and tells the page ("Too many messages…"). The owner has
no limit. User ids must match `[A-Za-z0-9_-]{1,64}`, so no thread's storage
prefix can contain another's.

**/dev/friends** (owner-only; a 404 for anyone else, like /dev/users) lists
everyone who has used the chat — email, first seen, last message, count —
with **Block**: it closes their sockets at once (4403), refuses their pages
and messages after, and ends any preview pairing made for them. Unblock
lets them back. A plain link works from Slack; `?thread=<userId>` shows that
friend's thread below the table, read-only.

**Preview on a friend's device (eval).** Friends use agent mode to get the
page they are looking at changed:

1. The friend describes the change in the chat (the line's label says which
   page and device).
2. The agent previews it live on the friend's own page by injecting it with
   eval. That needs **the friend's own consent on their device**: the owner's
   chat grant does not cover it, and the owner cannot answer for them.
   `eval.ts serve --for <email>` (it needs the owner's saved chat grant: no
   one else can raise the prompt) shows "<agent label> wants to preview a
   change on this page for 1 hour" with a 4-hex code on that friend's debug
   pages only; the agent tells them the code in the chat. **Allow for 1
   hour** pairs that sender for that friend's pages alone.
3. The agent opens a PR with the change.
4. **The owner approves before anything merges or deploys.** Friend-requested
   PRs are never merged or deployed without the owner's explicit approval
   ("部署上线要经过我的审批"); chat feedback goes straight to the agent, code
   to production does not. This is a process rule for the agent, not code.

**Security model.** Every pairing has one audience — the owner, or one
friend. Its prompt shows only on that audience's pages, only they can
Allow/Deny/End it, its evals reach only their pages, and only their pages'
results reach it. So an owner-approved sender can never run code on a
friend's device, and a friend-approved one never on the owner's. A pairing
for a friend is eval only: it hears no chat and cannot `say`. One pairing
may wait per audience. All of this is unit-tested in
`unit/debug-hub.test.ts` ("DebugHub friends", "eval scoping").

```bash
# The listener (as above) now prints every thread; a friend's line looks like
# {"type":"chat","id":"…","thread":"<userId>","email":"f@x.com","from":"friend",
#  "text":"…","at":"2026-10-29T…","label":"/words pwa Mozilla/5.0 (Linux; Android …)"}
bun scripts/dev/eval.ts chat --label "agent on $(hostname -s)" --out /tmp/lianki-chat.jsonl

# Reply to a friend (by email or user id); without --to it goes to the owner.
bun scripts/dev/eval.ts say --to f@x.com "Thanks — previewing it on your page now."

# Preview on that friend's pages: pair (they tap Allow), then eval as usual.
bun scripts/dev/eval.ts serve --for f@x.com --label "agent on $(hostname -s)"
bun scripts/dev/eval.ts --for f@x.com 'document.querySelector("h1").style.fontSize = "2rem"'
```

A listener that reconnects gets the owner thread's history only; friend
messages said while it was away are in `/dev/friends?thread=…`.

Fallback, if lianki-push is down: run code in a desktop lianki.com tab of
the owner's Chrome with `rech eval` — it reaches only that tab, not the phone.
