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
mode (`?debug=1` on any page, or seven quick taps on /words' Settings button or ten on your own name in the profile menu; `lk:debug`
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

**Sending side — pairing once, then a resumable grant.** The sender opens
`wss://lianki.com/api/version/debug/control?label=…` with no credentials
(a browser can't: any `Origin` header is refused). The sender declares what
it wants with `&scope=chat` (the `chat` listener) or `&scope=eval` (`serve`
and one-shot evals; the default). It can do nothing until the owner answers
the **pairing modal** (`packages/debug-chat/src/DebugPairModal.tsx`). The modal covers
at least half the screen on every open page of its audience, so on both
devices, and answering on one closes it everywhere. It shows the
requester's label, the 4-hex code the sender prints too, one sentence of what
Allow grants ("<label> wants to run code on your debug pages for 8 hours" /
"… wants to chat with you for 30 days"), for an eval request the audience's
open pages with a checkbox each (path, device hint; only this page ticked at
first), and large
buttons: **Authorize this page** (or "Authorize N pages" / "Authorize all
pages", following the ticks), **Authorize all pages**, and **Deny**. There is
no scope choice on the page: Allow grants what was asked for. An eval request
gets the 8-hour **eval grant** (`EVAL_GRANT_MS`; eval and chat); a chat
request gets the 30-day chat grant. Both are resumable (Scopes, below), so
the owner is asked once per sender, not once per command or per reconnect.
(A page from before still sends `scope:"chat"`, and that still counts.)

**Which pages.** A chat grant always covers every page of the owner: a
phone's page drops its socket after 30 s in the background and comes back,
so a per-page chat grant would keep dying. A chat request's modal therefore
has no page picker, and the hub ignores `pages` for it (also when resuming a
grant saved with pages by an earlier version). For eval,
`{type:"allow", pair, pages}` carries page ids or `"all"`. A page id is the
tab's own: generated once into `lk:debug-tab` in sessionStorage and sent as
`&tab=` on every (re)connect, so a reload or a background/foreground cycle
keeps it, and with it the grant. The hub grants exactly the ids of this audience's open
pages. With none valid, only the answering page is granted. Only `"all"` also
covers pages that connect later, and a page from before that sends no `pages`
means `"all"`. A page-scoped pairing's evals, busy beats and live `say`
replies (so also read-aloud) reach those pages only; history stays per
thread. Another page can join later with "Add this page" in the pill's menu
(the same `allow` sent for an approved pairing). While every page an eval
pairing was granted is away, its evals get `{type:"error"}` but it stays
open; once they have been away for 5 minutes (`PAGE_GONE_GRACE_MS`) the hub
closes that socket with 4409. Only the socket: the stored grant (and its
page ids) stays, so the sender reconnects with its token — silently — once
a page is back. No timer: the hub notes when the pages went and checks on
the next event of any kind, the way it checks expiry; a granted page coming
back resets the clock. **Deny** or **End** deletes the grant; the 8 hours
running out ends it. One pairing may wait at a time (2 minutes at most), so
prompts cannot be spammed; with no debug page open the sender is turned
away at once.

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
# Pair once (or resume the saved grant) and keep the session (run it in the
# background); approve the printed code on the device if it asks.
bun scripts/dev/eval.ts serve --label "lianki main lane on $(hostname -s)"

# Then, as often as needed for the next 8 hours:
bun scripts/dev/eval.ts 'document.title'
bun scripts/dev/eval.ts --target iPhone 'return [location.href, innerWidth, innerHeight]'
echo 'localStorage.length' | bun scripts/dev/eval.ts -
# An agent that must never prompt: fail instead.
bun scripts/dev/eval.ts --no-pair 'document.title'
```

**Never asking twice.** The rules (`scripts/dev/eval-grant.ts`, unit-tested
in `unit/dev-eval-grant.test.ts`): `serve` and one-shot evals save the eval
grant in `.debug-eval-token.json` beside the chat token (main checkout root,
gitignored, mode 600; `LIANKI_EVAL_TOKEN_FILE` overrides) and always try it
first. Only when it is missing, expired or refused (4498) do they pair, and
then at most once per process: a one-shot waits for that one answer and
never retries; a resume that fails for another reason (network) fails
rather than prompting. `--no-pair` fails instead of pairing. A `serve` whose
socket drops (4409, a deploy, the network) keeps running and resumes with
the token on the next command; End or Deny stops it. Without a running
`serve`, each command resumes the saved grant. The session's local port and
a random token are kept in `~/.config/lianki/eval-session.json` (mode 600)
while `serve` runs.

### Chat with the agent

Every owner page that holds the debug socket also shows a small chat box at
the bottom right (`packages/debug-chat/src/DebugChat.tsx`; collapsed to a pill by
default on /words). The owner types; the text goes out 3 s after the last
keystroke (a thin bar drains while it waits), or at once on Enter
(Shift+Enter is a newline) or when dictation drops in 3 or more characters at
once ending a sentence (。．.!?！？; keyboards and IMEs edit a character at a
time). The box is translucent until touched. While the input is not focused, the log shows only its last 3 lines (scrolled to the end, top edge faded, still click-through); focusing the input opens it to 30vh, in 150 ms (instantly with reduced motion), and the ↓ button keeps the input focused. Nothing is sent in the middle of an IME
composition. The header shows "agent listening (n)" — the approved senders
connected now, never a heartbeat-only `busy` socket; at 0 it reads
"connected · no agent listening". The hub sends every page a fresh `state` whenever a sender
connects, is approved, ends, expires or its socket closes or errors, so the
count follows the event, never a poll. Agent replies are read aloud with `speechSynthesis` (the
language is guessed from the script: kana → ja, Hangul → ko, other Han →
zh-CN, else en), one after another; typing cancels what is being read, and
the speaker button turns it off for the device (`lk:debug-chat-speak`). Only
replies arriving live are read, never the history, and only while the
chat input has focus in a visible tab (checked as each reply arrives);
focus leaving the input or the tab hiding stops the reading. iOS needs a gesture
first: the first tap or key inside the box unlocks speech.

**Wire.** Page → hub `{type:"chat", id, text}` (text ≤ 4000 chars); sender →
hub `{type:"say", text}`, acknowledged with `{type:"said", id}`. The hub
stores each as `{id, from:"owner"|"friend"|"agent", label, text, at, thread, email?}` — the last 200 per thread (Friends, below),
one Durable Object storage key each (`msg:<seq>`) — and broadcasts
`{type:"chat", message}` to every page and every approved sender. A page
gets `{type:"history", messages}` on connect, a sender on approval, so a
reload, a second device or a reconnecting listener sees what it missed.

**Scopes.** An eval grant (8 hours, `EVAL_GRANT_MS`) = eval and chat. A
chat grant (`chat` asks with `scope=chat`; 30 days) = chat only: the sender
hears the owner's messages and may `say`, but an eval is refused. Both
survive reconnects: on Allow the hub hands the sender a random 256-bit
**grant token** once, and keeps only its SHA-256 (`grant:<hash>` →
`{label, until, scope?, pages?, at?}`; no `scope` = chat). A sender that
connects with the header `x-debug-token: <token>` (or `x-liagent-token`, the
liagent CLI's name for it; if both are sent they must match, else 400) is
back in that grant's scope — for eval, with its page ids — without a prompt
(even with no page open) until it expires; a wrong or lapsed token is closed
with 4498. The CLI keeps the chat token in `.debug-chat-token.json` and the
eval token in `.debug-eval-token.json` at the root of the main checkout
(gitignored, mode 600). `say` and `busy` use the chat grant, else the eval
grant, and never pair. **End** on the session deletes the grant and closes
every socket using it; the listener then exits and forgets the token. An
eval grant no socket holds is still listed in the owner pages' menu (code
`idle`, pair `g:<start of its hash>`), so End — or Add this page — reaches
it while it sleeps. A chat grant whose listener is offline is not listed: it
lapses after 30 days, or ends at once by deleting the file — or reconnect
and End it. A friend's preview (below) is never stored: one socket, 1 hour.

**Logs.** `debug.chat` (owner message: page, length, first 80 chars),
`debug.say` (agent reply: sender, length, first 80 chars), `debug.resume`
(a grant used to reconnect), in `wrangler tail lianki-push`.

```bash
# Listen (in the background): one JSON line per new owner message on stdout
# — {"type":"chat","id","text","at","label"} — also appended to --out. The
# first time it prints {"type":"pending","code"}: tap Authorize in the modal.
bun scripts/dev/eval.ts chat --label "agent on $(hostname -s)" --out /tmp/lianki-chat.jsonl

# Reply (uses the saved grant; exits once the hub has it):
bun scripts/dev/eval.ts say "On it — fixing the swipe now."
echo "multi-line reply" | bun scripts/dev/eval.ts say -
```

The listener reconnects whenever its socket closes, backing off from 1 s to
a minute, by resuming its grant; no timer touches the network otherwise. It
pairs at most once per run: if its grant is refused (4498) it pairs once,
and if that pairing goes unanswered, is refused, or its grant is refused
again, it prints `{"type":"error"}` (stdout and `--out`) and stays idle
without asking the owner again until it is restarted, or another run saves
a chat grant (a file event; no polling).

**Presence (pages-idle / pages-back).** The hub counts each thread's open
pages (controllers and heartbeat sockets never count). When the last one
closes it stores `empty:<thread>` and sets the Durable Object alarm 60 s
ahead (`PAGES_IDLE_MS`, enough for a reload or a navigation; a quiet thread
has no other event to check on, so this is the one alarm). Still empty then,
the listeners get `{type:"pages-idle", thread, at}` and the heartbeat
sockets beating for that thread are closed (4411, `PAGES_IDLE`), so
`busy --every` exits. A page back inside the 60 s clears it silently; the
first page back after idle sends `{type:"pages-back", thread, label, at}`
(once). Any message also runs the check, and the alarm also runs the 4409
sweep. `chat` prints both as JSON lines and stays connected (hibernated, it
costs nothing) so pages-back can wake the agent; `chat --exit-on-idle`
exits on pages-idle instead. The red "End chat" in the menu is still the way
to end it for good. Logs: `debug.pages-idle`, `debug.pages-back`.

**Page moves.** The page's socket lives in the root layout, so it outlives
client-side navigation. On a route change (`usePathname`, plus `popstate` /
`hashchange`), settled for 300 ms, the page sends `{type:"page", label}`; the
hub relabels that socket alone (so later chat lines, eval `--target` and the
session listing carry the current path) and sends the listeners
`{type:"page-changed", label, thread, email?, at}`, which `chat` prints as a
JSON line. Silent on the page, never stored, never in the chat log. A
friend's page can only relabel its own socket.

**The pill and its menu.** No title bar: a small pill at the start of the
input row (`debug-chat-pill`) has two zones, each at least 32px, with a
divider. The left zone (`debug-chat-pill-min`) holds the liagent mark
(`packages/debug-chat/src/LiagentMark.tsx`) and a dot, green while the socket
is live: a tap minimizes or restores the box (after 280 ms, so that a double
tap can cancel it), and a double tap opens the menu (`packages/debug-chat/src/tap-gesture.ts`).
The right zone (`debug-chat-pill-menu`) shows the eval/preview sessions (a
play icon and their count, pulsing when code just ran) or ⋯; a tap opens the
menu at once. A drag anywhere on the pill moves the box, and never counts as
a tap. Minimized, only the pill stays (`debug-chat-minimized`, at 0.6
opacity, with an unread badge `debug-chat-pill-unread`), where it sat in the
box and with the same saved offset, so restoring puts the input row back
there, clamped on screen. While the pill is held, the input shows "drag:
move · tap: minimize · double-tap or ⋯: menu", as its placeholder, or over
the draft (`debug-chat-drag-hint`). The menu lists every open debug page of this chat (the
owner's own, or a friend's own: the hub's `state` carries `pages: [{id,
label, at}]` and `self`, rebroadcast when a page connects, leaves or moves).
Each row shows the path and a device hint ("pwa · Android", "iPhone"). Tapping
a row opens that path in this tab with the Next router, since other tabs and
devices cannot be focused, so the chat survives. Its light "disconnect"
(`{type:"end-page", id}`) has the hub close that page with 4410 "ended from
another page"; that page stays closed until its next visibility or debug
event. Disconnecting this page takes two taps. Eval and preview sessions keep
a light End. The menu has no End chat: the chat hibernates and wakes by
itself.

**Voice commits.** Every final spoken transcript is punctuated, then committed and sent at once (上屏): if Whisper left no stop, `punctuate()` adds one that fits the text (。/？ for CJK, ./? otherwise, a question by its particle or opening word). A short "好" or "OK" goes out too. Partials never send. Typed text arriving in one burst of 3+ characters that ends a sentence (an outside dictation IME) is also sent at once.

**Mic.** A mic button sits inside the input at its right edge
(`debug-chat-mic`; hidden where the browser lacks getUserMedia or Web Audio).
One tap turns hands-free listening on; another tap, or Escape, turns it off.
A voice-activity detector cuts speech into utterances: Silero VAD
(`@ricky0123/vad-web@0.0.30` on `onnxruntime-web@1.22.0`), loaded from
jsDelivr at those pinned versions on the first tap only (the ORT wasm is
~11 MB, too big to self-host), or, if that fails to load, an energy threshold
on the raw signal. Each utterance (at most 30 s; longer speech is cut and
goes on) is encoded as 16 kHz mono WAV and POSTed to `/api/debug/stt` as soon
as it ends; requests run in parallel and the text is appended to the draft
in the order spoken, with a faint "…" where a result is pending. Speech over
3 s also sends rolling partial chunks (every 2.5 s, overlapping by 1.5 s);
their merged text shows dimmed until the final text replaces it, and a 429
stops them until the next turn-on. A final transcript that leaves the
draft a sentence of 3 characters or more (trimmed, ending in 。．.!?！？) is
sent at once (`appendDictation`); otherwise the debounce waits while
listening or while transcripts are out, partials never send, and Enter sends
as usual. While audio is captured the button has a red pulsing ring and "REC"
(`debug-chat-mic-rec`); listening but quiet, a faint steady ring. Read-aloud
is paused while listening and resumed after. A short note
(`debug-chat-mic-note`) says when the mic is refused or missing, or the
route answers 401 (listening stops) or 429. On the owner's pages, if
localStorage `lk:debug-clip-sink` holds an https (or localhost) URL, each
final utterance is also POSTed as multipart (`audio`, and `meta` JSON
`{at, mime, durationMs, label, transcript, model}`) to `<sink>/clips`,
silently. The code is in `packages/debug-chat/src/` (`mic.ts`, the logic,
tested with fakes in `unit/mic.test.ts`; `MicButton.tsx`, the browser glue).

**One voice per device.** Every tab of a thread shows every message, but
only one reads a reply aloud: the focused tab, or else the one focused most
recently. Tabs agree over `BroadcastChannel("lk-debug-chat")`
(`packages/debug-chat/src/debug-chat-tabs.ts`), not the network. Drafts are not synced across
tabs (that would fight IME composition).

**Scrolling.** Scrolled up, new messages do not pull the log down (your own
do); a ↓ button at the right of the row above the input (the row stays
click-through, only the button takes taps) scrolls to the end, with a dot
when messages arrived below. The log's top edge fades once it overflows.

#### Agent is busy (heartbeat)

While the agent works on a message, a small spinner shows at the right end
of the chat input. It follows a real heartbeat, never a guess: the agent
sends `{type:"busy", to?, label?}` (named as in liagent; only an owner-approved controller —
chat grant or eval — and never a pairing made for a friend); the hub passes
`{type:"busy", label, at}` to that one thread's pages (the owner's by
default, a friend's with `to`), acks `{type:"beat", thread, delivered}`, and
stores nothing. The page shows the spinner while its socket is live, the last
beat arrived under 12 s ago, and no agent reply has landed since that beat
(`busyLeft` in `lib/dev-eval.ts`; a beat stamped within 1.5 s after a reply
is the loop's last one, in flight, and is ignored). One local timeout per
beat re-checks it — no network polling. The beat loop is the one timer that
touches the network, and the owner asked for it.

```bash
# One beat (the spinner shows for 12 s):
bun scripts/dev/eval.ts busy [--to f@x.com] [--label "fixing the swipe"]

# What the chat agent runs: start in the background on picking up a message.
# It beats every 4 s and exits by itself at the next agent reply in that
# thread (your `say`), or on kill, socket close, a closed stdin pipe, every
# page of the thread closed for a minute (pages-idle), or --max seconds
# (default 1800). --keep beats on past replies.
bun scripts/dev/eval.ts busy --every 4 [--to f@x.com] &
bun scripts/dev/eval.ts say "Done — the swipe snaps now."   # the beat stops
```

The beat process holds a grant socket while it runs, knocking with
`?beat=1`: the hub marks it heartbeat-only, so it keeps its grant and hears
the chat (to stop at the reply) but is not listed as a session in the menu
nor counted in "agent listening (n)" — a beat alone reads as "no agent
listening". On an eval grant, that grant stays listed as asleep (`idle`), so
End still reaches it.

**Test ids.** Every part of the debug UI has a `data-testid`, for evals and
tests:

- The chat box: `debug-chat` (root), `debug-chat-minimized` (minimized),
  `debug-chat-pill`, `debug-chat-pill-min`, `debug-chat-pill-menu`,
  `debug-chat-pill-unread`, `debug-chat-log`, `debug-chat-line` (with
  `data-from`), `debug-chat-input`, `debug-chat-drag-hint`,
  `debug-chat-bottom`, `debug-chat-busy`, `debug-chat-mic` (with
  `data-state` and `data-status`), `debug-chat-mic-rec`,
  `debug-chat-mic-pending`, `debug-chat-mic-note`, `debug-chat-notice` and
  `debug-chat-warning`.
- The pill's menu: `debug-menu`, `debug-menu-status`, `debug-menu-note` (where
  the widget came from, or why it fell back), `debug-menu-speak`,
  `debug-menu-minimize`, `debug-menu-page` (`data-self` on this one),
  `debug-menu-page-open`, `debug-menu-page-end`, `debug-menu-session`,
  `debug-menu-session-add` and `debug-menu-session-end`.
- The pairing modal: `debug-modal`, `debug-modal-code`, `debug-modal-pages`,
  `debug-modal-page-check` (`data-page-id`), `debug-modal-allow`,
  `debug-modal-allow-all` and `debug-modal-deny`.
- DebugEval's fallback (no chat box): `debug-eval`, with
  `debug-menu-session`, `debug-menu-session-end` (chat grants too) and
  `debug-chat-icon-eval` (its eval icon).

**Hot-loading the widget.** The chat box itself can be loaded live from a
dev server on the owner's pages, to see UI changes without a deploy:
[dev-debug-widget.md](dev-debug-widget.md).

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
   pages only, in the same big modal, listing only their own pages; the
   agent tells them the code in the chat. **Authorize** pairs that sender
   for the ticked pages of that friend alone, for 1 hour. (It needs the
   owner's chat grant — or the eval grant, which implies chat.) A preview
   pairing is not saved: each new `serve --for` or one-shot `--for` process
   asks the friend again, once; `--no-pair` makes it fail instead.
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
