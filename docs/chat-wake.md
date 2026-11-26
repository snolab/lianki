# Chat wake: wake any agent when someone names it

Goal: an agent that holds its own Lianki chat token (say one named **Arden**)
is woken only when a person in that token's own chat thread writes a line
naming it (`@Arden`, case-insensitive). One event type (`chat.mention`), one
thread, one line per event, no history. Phase 1 covers ChatGPT (push) and every
MCP client that can poll (pull). Other agents get their own adapters later,
behind the same `wake()`.

(This file was `docs/mcp-events.md`; that path is now a stub pointing here.)

Code: `lib/chat-wake/rules.ts` (pure: the event, the adapter interface, the
cursor), `lib/chat-wake/core.ts` (record and `wake()`),
`lib/chat-wake/pull.ts` (the pull adapter), `lib/chat-wake/principal.ts`;
the ChatGPT push adapter in `lib/mcp-events/*`; `app/api/mcp-events/route.ts`,
`workers/mcp/src/mcp.ts` (forwarding), `worker.ts` `DebugSessions.chatLog` (the
trigger), `db/migrations/0085_mcp_events.sql`, `0087_chat_wake.sql`. Tests:
`unit/mcp-events.test.ts`, `unit/chat-wake.test.ts`.

## Adapters

| agent                         | how it is woken                                                                        | adapter                                 | status                            |
| ----------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------- | --------------------------------- |
| ChatGPT (Work chats, dots)    | **push**: MCP Events webhook, signed POST to ChatGPT's callback                        | `chatgpt-webhook` (`lib/mcp-events`)    | built (flag `mcp.events`)         |
| Gemini app                    | **scheduled pull**: a scheduled action "check Lianki mentions" calls the tool          | `chat.wake.pull`                        | built (flag `chat.wake.pull`)     |
| Any MCP client, local agents  | **pull**: `lianki_chat_mentions_since` or SEP-3415 `events/poll`                        | `chat.wake.pull`                        | built                             |
| Claude Code                   | **push**: Routines (a scheduled or triggered cloud run) or Channels                    | a push adapter                          | planned                           |
| Local CLIs (Claude Code, Codex, Gemini CLI, opencode) | **listener**: `ay send` into the already-running session                   | `ay` (a pull client on the owner's Mac) | planned (see below)               |
| DeepSeek and others           | **hosted BYOK reply**: Lianki calls the user's own model and posts its answer          | a push adapter                          | planned (docs/byok.md)            |

### The adapter interface

`lib/chat-wake/rules.ts` `WakeAdapter`: `{ id, mode: "push" | "pull",
enabled(d), tokensIn?(d, thread, now), notLive?(d, token, thread, why, report),
wake(d, target, events, report) }`.

- `enabled` is the adapter's own flag, read live, fail closed. It sits on top
  of the core's `mcp.events`.
- A **push** adapter holds routes in D1 (ChatGPT: its subscriptions). It names
  the tokens it can reach in a thread (`tokensIn`), hears when one is no longer
  live (`notLive`: revoked, expired, out of scope, audience lost, or its thread
  changed), and delivers in `wake`.
- A **pull** adapter's `wake` is a no-op. The `chat_mention` row the core kept
  is the delivery, and the client reads it with its own token.

### Planned: `ay` for local CLIs

`ay` (agent-yes) is what the agent lanes already use (docs/lane-listen.md,
`scripts/dev/lane-listen.ts`, which call `ay send`). It types a line straight
into an already-running CLI session (Claude Code, Codex, Gemini CLI, opencode)
instead of starting a new one-shot run. It needs **no server push**, so it fits
as a pull client, not a new server route:

1. A listener on the owner's Mac holds a map *token → ay agent id* (one lane
   token per agent, as lane-listen does now).
2. For each token it calls `lianki_chat_mentions_since` (or `events/poll`)
   with that token and its stored cursor. It can wait on the token chat socket
   (`lianki chat listen`) and pull right after a line arrives, so nothing polls
   on a timer.
3. For each new mention it calls `ay send <agent id> "<the line>"` and stores
   the new cursor. The event id (`men_…`) is the dedupe key, so a restart never
   sends a line twice.

The server side is already done in phase 1: the rows, the cursor and the
token scope. What remains is the listener, which can reuse lane-listen's busy
check and hand-off rules.

## The core: one row per mention, one `wake()`

When the hub puts new lines of a thread (`DebugSessions.chatLog`, below):

1. **Pre-filter**: no person's line contains `@` or `＠`, so nothing is read.
2. Flag **`mcp.events`** on (fail closed). It is the core's gate.
3. **Candidates**: the tokens a push adapter routes to in this thread, plus
   the thread's own tokens (the `dev` holders' for `owner`, else that user's;
   at most `chat.wakeMaxTokens`) whose name a person's line names. Names are
   compared before any token is touched, so an unnamed token is never read.
4. Each candidate is checked **live by hash** (`principal`): live, `chat:read`,
   the account holds `dev`, and its thread is this one. If not, each adapter's
   `notLive` hears why.
5. **Record**: per person's line that names it (the loop guard and the matcher
   are `lib/mcp-events/rules.ts`), one `chat_mention` row. Its id is the event
   id, `men_` + SHA-256(token hash, line id), so a line put again is the same
   row (`fresh: false`). New rows are capped by `chat.wakePerMinute` per token.
   The named token's rows older than `chat.wakeRetentionDays`, and beyond
   `chat.wakeMaxPerToken` (oldest first), are deleted at the same time. Every
   new row also deletes at most `chat.wakePurgeBatch` expired rows of **any**
   token, oldest first. So a token that is never polled or named again still
   loses its old rows, with no cron.
6. **`wake(target, events)`**: the events, deduped on their id, go to every
   enabled adapter. If one adapter throws, the others still run.

The ChatGPT adapter ignores `fresh`. As before the refactor, a line put again is
POSTed again with the same `eventId`, and ChatGPT dedupes on `webhook-id`.

### D1 `chat_mention` (migration 0087)

| column       | meaning                                                         |
| ------------ | --------------------------------------------------------------- |
| `seq`        | AUTOINCREMENT, never reused: the tie-break in the cursor order  |
| `id`         | the event id `men_…`, unique                                    |
| `token_id`   | the API token's public id (`api_tokens.token_hash`)             |
| `thread`     | the token's own thread when it was named                        |
| `line_id`    | the chat line's id                                              |
| `text`       | the line's text (at most 4000 characters)                       |
| `author`     | `owner` or `friend`                                             |
| `created_at` | ms                                                              |

When a token row is deleted, or its OAuth grant is, a trigger deletes that
token's rows in the same statement. Indexes: `(token_id, created_at, seq)` for
paging, and `(created_at)` for the purge across tokens. Not applied anywhere
yet: apply it with 0085 before turning the flags on.

## Pull: `lianki_chat_mentions_since` and `events/poll`

Flag **`chat.wake.pull`** (default **on**, audience owner), on top of
`mcp.events`. While either is off, both answer `-32601 Method not found`, and
`events/list` lists `delivery: ["webhook"]` exactly as before. While both are
on, `events/list` lists `["webhook", "poll"]`. Both forms need `chat:read`
(otherwise `-32003` with `needScope`). Both return only rows where `token_id`
is the caller's own token and `thread` is that token's thread now. There are
no arguments for naming another thread or token.

- **Tool** `lianki_chat_mentions_since {cursor?, limit?}` (in
  `packages/lianki-cli/mcp-tools.mjs`, so the remote `/mcp` and the local
  `lianki mcp` both offer it). It calls `POST /api/mcp-events`
  `{method: "chat/mentions"}` and returns `{mentions: [{id, lineId, text,
  author, at}], cursor, hasMore, truncated}`, oldest first. Without a cursor it
  returns the last `chat.wakePullTtlMin`, which is what a Gemini scheduled
  action needs ("check Lianki mentions" once an hour). With a cursor it returns
  only newer rows. `limit` defaults to `chat.wakePullLimit`, at most 100.
- **`events/poll`** (SEP-3415, `seps/3415-events-extension.md`), on the same
  `/mcp` endpoint and forwarded like the other `events/*`:
  `{name: "chat.mention", arguments: {}, cursor, maxAgeMs?, maxEvents?}` →
  `{resultType: "complete", events: [{eventId, name, timestamp, data: {id,
  text, author}}], cursor, truncated, hasMore, nextPollMs}`. There is no
  subscribe step: a `null` cursor bootstraps "from now" and returns no events.
  `maxAgeMs` is a floor (capped at `chat.wakePullTtlMin`). `nextPollMs` is
  `chat.wakeNextPollMs`. `data` is the webhook's payload.
- **Cursor**: an opaque, stable position, `w2.<created_at>.<seq>`, holding
  the last row seen. Rows are ordered by `(created_at, seq)`, and the next page
  starts strictly after that position (`created_at > at OR (created_at = at AND
  seq > seq)`). It is a value, not a row, so rows deleted before or at it never
  shift a page or skip a row that is still kept. `seq` 0 names no row ("up to
  `at`"): a bootstrap, or a token with nothing yet.
- **`truncated`**: retention and the cap delete oldest first. So rows after a
  cursor can be gone only if the cursor's own row is gone, and then the next
  page says `truncated: true` while still returning every row that is kept. A
  row-less cursor older than the retention says the same. If such a page is
  empty, the cursor moves to the token's newest row, so the gap is reported
  once.
- **Rate**: `chat.wakePullPerMinute` calls per token (tool and poll together),
  then `-32005` with `retryAfterMs`.

Not done: the SEP's `server/discover` and its
`capabilities.extensions["io.modelcontextprotocol/events"]` key. The server
still advertises OpenAI's `capabilities.events: {}` from `initialize`, which
covers both forms. The SEP's provisional error codes (-32023 to -32027) are not
used either. We keep the codes the webhook already answers (-32602, -32005,
-32015) until the SEP is accepted.

### Config keys (lib/config.ts, group `chat`, /dev/config)

| key                      | default | meaning                                                  |
| ------------------------ | ------- | -------------------------------------------------------- |
| `chat.wakeRetentionDays` | 7       | how long a `chat_mention` row is kept                    |
| `chat.wakePerMinute`     | 10      | new rows per token per minute                            |
| `chat.wakeMaxPerToken`   | 500     | rows kept per token at most (oldest dropped)             |
| `chat.wakePurgeBatch`    | 100     | expired rows of any token deleted per new row            |
| `chat.wakeMaxTokens`     | 50      | the thread's own tokens compared per line                |
| `chat.wakePullTtlMin`    | 1440    | the tool's window without a cursor; `maxAgeMs` cap       |
| `chat.wakePullLimit`     | 20      | rows per pull by default (at most 100)                   |
| `chat.wakePullPerMinute` | 30      | pull calls per token per minute                          |
| `chat.wakeNextPollMs`    | 60000   | `nextPollMs` in an `events/poll` answer                  |

# Push: ChatGPT through MCP Events

A ChatGPT session connected to `https://lianki.com/mcp` with its own chat
token subscribes to `chat.mention` and is woken by a signed webhook.

Behind the flag **`mcp.events`** (default **off**, audience owner). Spec:
OpenAI's [MCP Events](https://developers.openai.com/plugins/build/mcp-events.md)
(it follows the draft
[triggers and events extension](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md)).

## Does our server support it?

Yes, without a rewrite. The spec needs Streamable HTTP with `initialize` (or
MCP 2.0 HTTP, protocol `2026-07-28`, with `server/discover`). lianki-mcp is
stateless Streamable HTTP and already speaks `2025-03-26` through
`2025-11-25`. Events need no server-to-client stream: ChatGPT subscribes with
an ordinary JSON-RPC call and we POST webhooks to it. So the work is three new
methods on the same endpoint, one capability key, a table and a trigger point.

Not done: MCP 2.0 HTTP (`server/discover`). ChatGPT still accepts
`initialize`; add `server/discover` when we adopt 2026-07-28 for tools too.

## Voice (ChatGPT Live): what reaches it

Arden runs in ChatGPT's live voice mode. What OpenAI documents (read
2026-11-27):

- **Tools in voice: yes.** ChatGPT Business release notes, 2026-09-23: "Live
  now supports plugins on web, iOS, and Android", using the plugins and
  connected apps on the account, with written answers in the chat. An older
  help article ("Apps in ChatGPT") still says voice mode does not support
  apps. The release note is newer. So Arden can call Lianki's MCP tools while
  talking.
- **MCP Events in voice: not documented.** The MCP Events page lists only
  "Work chats on ChatGPT web", "Work chats in the desktop app with Cloud
  selected", and dots. It says ChatGPT "receives the event in the subscribed
  chat" and processes it "asynchronously", as a task run. It says nothing
  about voice or Live, or about notifying the user. Assume an event **does not
  speak into a live voice call**.

Closest supported routes, recommended first:

1. **Subscribe from a Work text chat, and let the event run there.** Arden (or
   the user) subscribes once in a Work chat on the web. Each `@Arden` line then
   runs a task in that text chat, which she can open on any device. The
   release notes also say a voice call in Work can hand an unfinished task over
   to text. The result is that the event lands in text and she reads it, or
   starts voice from that chat. Needs: a Work workspace with plugins and
   event-triggered tasks allowed by its admin.
2. **In voice, poll on demand with `lianki_chat_wait` / `lianki_chat_read`.**
   These tools already exist (55 s long wait on the token's thread). In a voice
   call Arden calls them when the user asks "anything for me?". This needs
   nothing new, but nothing wakes her by itself.
3. **Lianki speaks instead of ChatGPT.** A mention is already in the Li chat,
   which reads lines aloud on his devices. For a hands-busy user, Li's
   read-aloud of the line plus option 2 is the voice route that exists today.
4. **Later: a dots or Work task as the receiver.** If OpenAI documents events
   reaching a live session, nothing here changes: the webhook is the same.

## Event: `chat.mention`

`events/list` returns one definition:

- `inputSchema`: `{}` (no arguments, `additionalProperties: false`). The
  thread is never an argument: it is the token's own, so a subscription cannot
  name another user's thread.
- `payloadSchema`: `{ id, text, author }`. `author` is `"owner"` or `"friend"`
  (the line's `from`). No names, no thread id, no history.
- `delivery`: `["webhook"]`. Not replayable: `cursor` is always `null` and
  `truncated` `false`. A line written while no subscription was live is never
  sent later.

The capability is advertised (`capabilities.events: {}`) only when the main
Worker says events are on for this token (`events/probe`, below). While the
flag is off, or for an account outside the audience, the server looks exactly
like one without events: no capability, and `events/*` answer
`-32601 Method not found`.

## Flow

```
ChatGPT ──POST /mcp events/subscribe──▶ lianki-mcp ──POST /api/mcp-events (same Bearer)──▶ main Worker
                                                                                   │ checks token, flag, audience
ChatGPT ◀──signed verification POST (challenge)────────────────────────────────────┤
                                                                                   └ D1 mcp_event_subscription
person writes "@Arden …" ──▶ lianki-push DebugHub ──SESSIONS.chatLog put──▶ main Worker
                                                                   waitUntil(mentionEvents) ──signed POST──▶ ChatGPT
```

lianki-mcp still holds no data and no secret. It forwards `events/list`,
`events/subscribe` and `events/unsubscribe` with the caller's own token to
`POST /api/mcp-events`, as it forwards tools. On `initialize` it also asks
`events/probe` (one extra call per connect, and a failure means "off").

The trigger needs **no change to lianki-push**. Every kept line already goes
to the main Worker over `SESSIONS.chatLog` (`op: "put"`, lib/chat-log.ts), with
`thread`, `id`, `from` and `text`. `DebugSessions.chatLog` writes the history
as before, then runs `mentionEvents` in `waitUntil`, so the hub's answer is
never held up.

## Storage: D1 `mcp_event_subscription` (migration 0085)

| column                                | meaning                                                                                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                  | `sub_` + 32 hex of SHA-256(token hash, callback URL, event name, canonical-JSON arguments): deterministic, so idempotent                             |
| `token_hash`, `user_id`               | the principal: the API token (its public id), and its account                                                                                        |
| `thread`                              | the token's own thread at subscribe time (`threadFor`); re-derived live on every delivery                                                            |
| `name`, `arguments`, `url`            | the subscription identity                                                                                                                            |
| `secret_sealed`                       | the `whsec_` secret, AES-256-GCM with an HKDF key from AUTH_SECRET (`lib/connections/crypto.ts`, purpose `mcp-events-secret`), AAD = id + token hash |
| `prev_secret_sealed`, `prev_until_ms` | the previous secret during a rotation overlap                                                                                                        |
| `expires_at_ms`, `verified_at_ms`     | lifetime; when the callback last proved itself                                                                                                       |
| `last_event_at_ms`, `failures`        | delivery bookkeeping                                                                                                                                 |

The next migration number was 0085 (prod had 0084_mcp_oauth). Not applied
anywhere yet. It is applied with the usual D1 migration step before the flag
is turned on.

## Subscribe, refresh, unsubscribe

`events/subscribe {name, arguments, delivery:{mode:"webhook", url, secret}, cursor, ttlMs?}`:

1. The token is live and holds `chat:read` (a `chat:write`-only token gets
   `-32003` with `needScope`). Unknown, expired or revoked: HTTP 401.
2. Flag on, and the account holds `dev` (the owner audience, read live from
   `account_permission`). Otherwise `-32601`.
3. Arguments validated (`{}` only); `mode` must be `webhook`.
4. Callback URL (`callbackUrl`): `https`, default port, no credentials, no
   fragment, a DNS name (no IP literal of any spelling), not `localhost`,
   `.internal`, `.local`, `.ts.net` and the like, and never `lianki.com` or a
   subdomain (that could loop).
5. Secret: `whsec_` + base64 of 24–64 bytes.
6. Rate limit `mcp.eventsSubscribePerHour` per token. An early check refuses
   a token already at `mcp.eventsMaxPerToken` live subscriptions before any
   network call.
7. **Verification**: first the host must be on the allowlist, and it is
   resolved and checked (see "Callback addresses"). Then a signed POST `{type:"verification", challenge}` (random,
   single use) with the same headers as an event. Success is only a 2xx whose
   JSON echoes `challenge`, compared in constant time. The answer is read as a
   stream, at most 4096 bytes (`MAX_ANSWER_BYTES`; past that the read is
   cancelled). One deadline, `mcp.eventsTimeoutMs`, covers the request, the
   status and the whole body read, so a body that trickles in is a timeout.
   Failure: JSON-RPC `-32015` (`CallbackEndpointError`) with `data.reason` set
   to `challenge_failed`, `timeout`, `unreachable`, `unresolved`,
   `private_address` or `host_not_allowed`, and nothing stored. Success is cached per token and URL
   for `mcp.eventsVerifyCacheMin`, so a refresh with the same secret does not
   re-verify.
8. Only after verification, one statement writes the row and enforces the cap:
   `INSERT … SELECT … WHERE EXISTS (this id) OR (SELECT COUNT(*) of the token's
live rows) < cap … ON CONFLICT(id) DO UPDATE … RETURNING id`. No row
   returned means the cap was reached (`-32005`), so concurrent subscribes that
   all passed the early check cannot exceed it. A refresh of an existing row is
   never blocked.
9. Answer `{id, refreshBefore, cursor: null, truncated: false}`. Lifetime:
   `min(asked ?? mcp.eventsTtlMin, mcp.eventsMaxTtlMin)`. `null` ("no expiry")
   is granted as the longest, with a real `refreshBefore`, since we never grant
   unbounded subscriptions. The default is capped by the longest too, so
   setting the longest below the default shortens every subscription.
   `refreshBefore` = 90% of the lifetime.

## Callback addresses

**The control is an allowlist of callback hosts**: `mcp.eventsCallbackHosts`
(lib/config.ts; /dev/config). Lianki only POSTs to a host on that list.
`rules.ts hostAllowed` is checked at subscribe, before any lookup or request,
and again right before each verification and each delivery attempt. The list
is re-read from D1 for every delivery attempt (not a snapshot of the batch),
so narrowing it stops a delivery already in flight at its next attempt; only a
POST already being sent finishes. An entry `host` matches that host
only; `.suffix` matches its subdomains but not the suffix itself. An empty list
allows nothing. A refused host answers `-32015` with reason `host_not_allowed`.

The default is `["connectors.api.openai.com"]`. OpenAI's MCP Events guide
names no callback host: its example is `receiver.example.com`, and it says
only to validate, verify and block non-public addresses. That host is the one
ChatGPT is reported to use (community field reports and demos, 2026-11), so it
is an observation, not a documented contract. If ChatGPT's subscribe is
refused with `host_not_allowed`, the owner adds the exact host it used at
/dev/config. Keep entries exact, or as narrow a `.suffix` as possible.

**Why this answers rebinding.** Workers have no fetch pinned to an IP: `fetch`
takes a URL and resolves the name itself, and `cf.resolveOverride` only
re-points to hosts in our own zone. So a DNS check followed by a fetch that
resolves again is not a guarantee on its own. With the allowlist, the only
names ever fetched are OpenAI's own. A rebinding attack would need control of
OpenAI's DNS, which is out of scope: we already trust that host with the
events' content.

**Second layer: public addresses.** Right before each verification and each
delivery attempt, after the allowlist, the host is also resolved fresh through
DNS over HTTPS (`https://cloudflare-dns.com/dns-query`, A and AAAA together,
`deps.ts resolveDoh`). The attempt goes ahead only when there is at least one
answer and **every** answer is public (`rules.ts publicAddress`). This catches
a misconfigured allowlist entry or a trusted name pointing somewhere private.
Refused:

- IPv4 private (10/8, 172.16/12, 192.168/16), loopback (127/8), link-local
  (169.254/16, including the 169.254.169.254 cloud metadata address), CGNAT
  (100.64/10), "this network" (0/8), multicast and reserved (224/3), and the
  documentation and benchmarking ranges;
- IPv6 `::`, `::1`, ULA (fc00::/7, including the fd00:ec2::254 metadata
  address), link-local, site-local, multicast, documentation and discard, and
  anything outside global unicast 2000::/3;
- any IPv6 form carrying an IPv4 address (mapped, compatible, NAT64, 6to4,
  Teredo), judged by that IPv4.

A name with no A or AAAA answer, or a resolver failure, is `unresolved`. At
verification that refuses the subscription. At delivery, a private answer ends
the delivery and an unresolved one counts as a failed attempt, retried.

**Third layer: Workers egress.** A Worker's outbound `fetch` leaves through
Cloudflare's edge to the public internet. It cannot reach a private network
(RFC 1918, loopback, link-local) of Cloudflare's or anyone's, unless a binding
such as a Tunnel or VPC service is attached, and lianki's main Worker has none
for this.

**Streams.** A callback's answer body is cancelled without waiting
(`cancelSoon`): a cancel that never settles cannot hold an attempt past its
deadline.

**Secret rotation**: a re-subscribe with a new secret keeps the old one for
`mcp.eventsRotationOverlapMin`. During that time every delivery carries both
signatures, space-separated.

`events/unsubscribe {name, arguments, delivery:{mode, url}}` derives the same
id, deletes it for this token only, and answers `{}`. It is idempotent.

## Delivery

For a `put` of lines in thread T:

1. **Cheap pre-filter**: no person's line contains `@` or `＠`, so nothing is
   read from D1. Most lines stop here.
2. Flag on (fail closed).
3. Subscriptions `WHERE thread = T AND name = 'chat.mention' AND not expired`.
4. Per subscription: re-check the token **live by hash** (`checkToken`,
   `chat:read`). Unknown, expired or out of scope deletes the subscription.
   Then re-check the audience (`dev`), and re-derive its thread: it must equal
   T. A site sub-thread (`owner~<hash>`) never matches, so it is "only that
   token's thread".
5. Per line: the **loop guard** (below), then `mentions(text, tokenName)`, then
   the rate limit `mcp.eventsPerMinute` per subscription (D1 counter).
6. POST one JSON object:
   `{eventId, name: "chat.mention", timestamp, data: {id, text, author}, cursor: null}`,
   at most 256 KiB, serialized once. Headers: `content-type`,
   `webhook-id` (= eventId), `webhook-timestamp` (Unix seconds),
   `webhook-signature` (`v1,<base64 HMAC-SHA256("<id>.<ts>.<body>")>`, Standard
   Webhooks, key = the decoded `whsec_` bytes), and `X-MCP-Subscription-Id`.
   `eventId` = `evt_` + a hash of the subscription and line id, so a retry or a
   repeated `put` of the same line has the same id and the receiver dedupes it.
7. **Before every attempt** the host must be on the allowlist, and it is
   resolved and checked again ("Callback addresses"). Then, **immediately before
   every POST**, the first attempt included and after every await (the backoff,
   the DNS answer, the signing), everything is re-checked live: the flag, the
   row (not unsubscribed, not expired), the token (known, unexpired,
   `chat:read`, not revoked), the audience, and that its thread is still the
   subscription's. If anything fails, it stops without sending, and the put's
   other lines are not sent to that subscription either. So an unsubscribe,
   revoke or flag-off after the first line of a batch stops the second.
   **Timeout** `mcp.eventsTimeoutMs` (default 6 s; the spec's
   example is 10 s) covers the whole exchange; the answer's body is cancelled
   unread. `redirect: "manual"`, so a 3xx is a failure and is never followed.
8. **Retries**: 408, 429, 5xx, a timeout or a network error retry up to
   `mcp.eventsRetries` times. The waits are `mcp.eventsRetryBaseMs` × 1, 2, 4.
   Each retry goes through the same checks as step 7. Each retry has the same
   eventId, a fresh timestamp and a fresh signature. **410** deletes the
   subscription. **413** and other 4xx give up at once. The defaults (per
   attempt 2 s DNS + 6 s POST, × 3, plus 1 s + 2 s of backoff = 27 s) fit inside
   the Worker's `waitUntil` budget.

The mention match (`mentions`): NFKC and lower case on both sides (so `＠Ａｒｄｅｎ`
counts). The `@` must not follow a letter or digit (`bob@arden.example` is not
a mention). The name must end at a non-letter (`@Ardent` and `@Arden-bot` do
not name Arden), unless the name ends in Han, kana or Hangul (`@小克你好` names
小克). The name is the token's name (`api_tokens.name`, the lane label), read
live, so a rename takes effect at the next line.

## Loop prevention

- **Only a person's line triggers**: `from` is `owner` or `friend`. Every line
  a token posts is an agent line (`from: "agent"`, token-chat.ts), so Arden's
  own reply, even one quoting `@Arden`, can never wake Arden. Another agent
  naming her cannot either, so two agents cannot ping-pong.
- A callback can never be Lianki itself (`lianki.com`, `*.lianki.com`).
- The per-subscription rate limit caps any burst, including a person pasting
  the same mention many times.
- The trigger is `put` only: a later edit (`update`, `split`, a polish) never
  re-sends a line.

## Revocation and the flag

- **Token revoked** (one token, "sign out everywhere", account deletion): a
  D1 trigger `AFTER DELETE ON api_tokens` deletes its subscriptions in the
  same statement. An OAuth app disconnected (`mcp_oauth_grant` row deleted)
  does the same through a second trigger. No code path can forget it.
- **Expired, scope removed, or `mcp.oauth` off** (an OAuth token goes dead
  without its row being deleted): the next delivery's live `checkToken` fails,
  and the subscription is deleted, nothing sent.
- **Audience lost** (`dev` revoked): nothing is sent. The row is kept and
  expires on its own.
- **Flag off**: the capability disappears, subscribe and list answer
  `-32601`, and nothing is delivered. The rows stay; turning the flag on again
  resumes.

## Config keys (lib/config.ts, group `mcp`, /dev/config)

| key                            | default                         | meaning                                          |
| ------------------------------ | ------------------------------- | ------------------------------------------------ |
| `mcp.eventsCallbackHosts`      | `["connectors.api.openai.com"]` | the only callback hosts (`.suffix` = subdomains) |
| `mcp.eventsSubscribePerHour`   | 30                              | subscribe / refresh calls per token per hour     |
| `mcp.eventsMaxPerToken`        | 3                               | live subscriptions per token                     |
| `mcp.eventsPerMinute`          | 10                              | deliveries per subscription per minute           |
| `mcp.eventsTtlMin`             | 1440                            | lifetime when ChatGPT asks none                  |
| `mcp.eventsMaxTtlMin`          | 10080                           | the longest lifetime granted                     |
| `mcp.eventsTimeoutMs`          | 6000                            | per POST incl. the body read (verify, events)    |
| `mcp.eventsRetries`            | 2                               | retries after a transient failure                |
| `mcp.eventsRetryBaseMs`        | 1000                            | first backoff, doubling                          |
| `mcp.eventsVerifyCacheMin`     | 60                              | re-use a verification for the same token+URL     |
| `mcp.eventsRotationOverlapMin` | 60                              | old secret keeps signing after a rotation        |

## Rollout

1. Apply migrations 0085 and 0087 to D1 (0086 is the costs branch) (owner step; not done).
2. Deploy main and lianki-mcp.
3. Turn `mcp.events` on at https://lianki.com/dev/flags#mcp.events. Check
   `mcp.eventsCallbackHosts` at /dev/config.
4. In a ChatGPT Work chat on the web, connect Lianki with a chat-only token
   named e.g. Arden, and ask it to subscribe to `chat.mention`.
5. Write `@Arden …` in the Li chat and check the task run in that Work chat.

## Open questions

- **Voice**: see "Voice (ChatGPT Live)". Events are documented for Work chats
  and dots only.
- **The callback host**: OpenAI documents none. The default
  `connectors.api.openai.com` is observed, not contractual. If OpenAI moves it,
  subscribes fail with `host_not_allowed` until the owner adds the new host at
  /dev/config. DNS rebinding is out of scope: only allowlisted OpenAI hosts
  are ever fetched ("Callback addresses").
- **Retries in-isolate**: retries run inside `waitUntil`, so a Worker restart
  loses them. A Cloudflare Queue would make them durable (a new binding).
- **Audience**: the owner audience is enforced as "the account holds `dev`".
  Widening it to every user is a one-line change in `principal()` plus the
  flag's `audience`, but a user's thread is their Learning Partner thread, so
  check the Partner's own replies stay `from: "agent"` first.
- **Which name**: the match uses the token's name. The owner can also rename a
  participant on his page (debug.ts `participant`), but that name lives in the
  DebugHub, not in D1, so it is not matched.
- **AUTH_SECRET rotation** makes the sealed secrets unreadable. Those
  subscriptions are then dropped at the next mention, and ChatGPT re-subscribes
  at its next refresh.
