# Agent channel protocol (design)

Status: **design, nothing built.** Owner request, 2026-11-27: a user runs their
own agent under `ay` (agent-yes: the open-source runner that drives Claude
Code, Codex, Gemini CLI, opencode and others); Lianki posts the user's chat
messages to that agent and receives its replies, its streaming text, its
status and its permission prompts, over a channel. Lianki and ay never depend
on each other. Both implement one common protocol, including a streaming JSON
Lines mode, and a tiny adapter joins them.

Related: [lane-listen.md](lane-listen.md) (today's owner-only lane listeners),
[api-for-agents.md](api-for-agents.md) (tokens for users' own assistants),
[lianki-dev-cli.md](lianki-dev-cli.md), the public CLI's agent chat workflow
(`packages/lianki-cli/README.md`).

## 1. Goal and the no-mutual-dependency rule

**Goal.** Any Lianki user, not only the owner, can say "@my-agent, fix the
failing test" in their Li window and see the agent's answer stream into the
same window, its busy/idle state on its avatar, and its "may I run `rm`?"
prompt as a tap card, while the agent keeps running on their own machine under
ay.

**The rule.** Three independent pieces, each useful alone:

| piece          | owned by       | works without the others as                                          |
| -------------- | -------------- | -------------------------------------------------------------------- |
| Lianki chat    | `snolab/lianki` | the chat, `lianki chat listen --json`, MCP, tokens (today)          |
| ay             | agent-yes repo | `ay send` / `ay tail` / `ay read` / `--stream`, any terminal (today) |
| the protocol   | a spec, no code | a document both repos cite; each repo ships its own side            |

- Lianki never imports ay code, never shells out to `ay` from the Worker, and
  never assumes ay is installed. ay never imports Lianki code, never calls
  lianki.com, and never knows what a Lianki token is.
- Each repo implements its own **endpoint** of the protocol in its own code:
  Lianki's in `packages/lianki-cli` (`lianki chat channel`), ay's in its own
  CLI (`ay channel`). Neither endpoint knows the other's product; each only
  knows the protocol.
- The **bridge** is a pipe between two endpoints that speak the protocol. In
  the simplest case it is the shell: `lianki chat channel --stdio | ay channel
  --stdio` with the return path below. No third package is required.
- Any other chat (a Slack bot, a Matrix bridge) or any other runner (a plain
  Claude Code `--input-format stream-json` process, an ACP agent) can take
  either side.

Today's coupling to undo: `lianki chat listen --deliver` / `lianki chat bridge`
(`packages/lianki-cli/chat-bridge.mjs`) and `scripts/dev/lane-listen.ts` spawn
`ay send` and parse `ay ls --json` / `ay tail` screens. That stays working; the
protocol replaces it for new installs (phase 4).

## 2. Survey: what exists

| standard                                           | shape                                                                                                                                                                                                                             | multi-party | streaming                                    | permission prompt                                      | transports                              |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------- | ------------------------------------------------------ | --------------------------------------- |
| **ACP** (Zed's Agent Client Protocol)              | JSON-RPC 2.0, client (editor) ↔ agent. `initialize` (`protocolVersion`, capabilities), `session/new`, `session/load`, `session/prompt` (one turn, returns `stopReason`), `session/cancel`; agent → client `session/update` notifications | no (1:1)    | `session/update` `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan` | `session/request_permission` with options (`allow_once`, `allow_always`, `reject_once`, `reject_always`) → `outcome` | stdio (newline-delimited JSON-RPC, protocol v1); RFD "Streamable HTTP + WebSocket transport" in Draft since 2026-04-22 (one `/acp` endpoint, `Acp-Session-Id`) |
| **MCP** (revision 2026-07-28)                      | JSON-RPC 2.0, client ↔ server; tools, resources, notifications. 2026-07-28 drops the connection-scoped `initialize` (version and capabilities per request in `_meta`) and server-to-client requests                               | no          | progress notifications only                  | none of its own (elicitation is user input, not tool approval) | stdio, Streamable HTTP (SSE inside); no WebSocket |
| **Claude Code channels** (`notifications/claude/channel`, research preview) | a stdio MCP server declaring `experimental['claude/channel']` pushes `notifications/claude/channel {content, meta?}` into a running interactive session (queued while busy, no ack); replies go out through the server's own tools | no          | no (whole messages)                          | with `experimental['claude/channel/permission']`: `…/channel/permission_request {request_id, tool_name, description, input_preview}` → `…/channel/permission {request_id, behavior: allow\|deny}`, first answer wins | MCP stdio; `--channels`, custom ones only with a development flag, not with `-p` |
| **MCP SEP-3415** (events extension, Final)         | `io.modelcontextprotocol/events`: `events/list`, `events/poll`, `events/stream`, `events/subscribe` (webhooks); `notifications/events/event {eventId, name, timestamp, data, cursor?}`, at-least-once, dedup by `eventId`, `maxAgeMs` replay, `truncated` gap | no          | event push                                   | n/a                                                    | MCP transports; Standard Webhooks        |
| **Claude Code stream-json**                        | JSONL on stdout: `system` (`init`, with `capabilities[]`), `assistant`, `user`, `result` (`success`, `error_max_turns`, `error_during_execution`, …); `stream_event` with `--verbose --include-partial-messages`; stdin JSONL `{"type":"user","message":{...}}` with `--input-format stream-json` | no          | `stream_event` (raw API `text_delta`)        | control protocol `control_request` (the SDK's `canUseTool`), or `--permission-prompt-tool` | stdio                                   |
| **Codex `exec --json`**                            | JSONL on stdout: `thread.started`, `turn.started`, `item.started` / `item.updated` / `item.completed` (`agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `todo_list`, …), `turn.completed` / `turn.failed`, `error` | no          | none: `item.updated` is a snapshot, not a token delta | none in `exec` (sandbox/approval policy up front). `codex app-server` (JSON-RPC, stdio or experimental WebSocket) has `item/agentMessage/delta` and `item/commandExecution/requestApproval` | stdio (output only); app-server stdio/ws |
| **Gemini CLI headless**                            | `--output-format json` (one object) or `stream-json` JSONL: `init`, `message` (`delta: true`), `tool_use`, `tool_result`, `error`, `result`. Its docs say Antigravity CLI replaced it on 2026-06-18                                   | no          | `message` `delta: true`                      | none headless; ACP mode (`gemini --acp`) has it       | stdio                                   |
| **A2A** 1.0 (Agent2Agent, Linux Foundation)        | JSON-RPC 2.0 / gRPC / HTTP+JSON between agents; Agent Card at `/.well-known/agent-card.json`; `SendMessage`, `SendStreamingMessage` (SSE), `GetTask`, `CancelTask`, `SubscribeToTask`; `statusUpdate`, `artifactUpdate` (`append`, `lastChunk`); `A2A-Version` header | agent ↔ agent | SSE `artifactUpdate`                         | no permission type; modelled as `TASK_STATE_INPUT_REQUIRED` | HTTP + SSE, gRPC; push webhooks          |

Sources: see §16.

What the survey says:

1. **ACP is the closest fit for the agent side.** It is exactly "a UI drives a
   local coding agent over stdio, streams its text and tool calls, and asks the
   human for permission", it is open (Apache-2.0), versioned, and already
   spoken natively or through adapters by Gemini CLI, Claude Code, Codex and
   opencode (Gemini CLI `gemini --acp` and `opencode acp` natively; Claude Code
   through `@zed-industries/claude-agent-acp`, Codex through `codex-acp`). Its vocabulary (session, prompt turn, update kinds, permission
   options and outcomes, stop reasons) is what we need.
2. **ACP is 1:1 and request/response-shaped.** A chat is many-to-many (the
   user, several agents, a phone and a laptop open at once), messages arrive
   while a turn runs, and the chat side must survive reconnects with a cursor.
   JSON-RPC's `id`-matched requests across a reconnecting WebSocket and a
   one-way SSE stream are awkward.
3. **A2A is the closest fit for the transport shape** (HTTP + SSE, task
   states including `input-required`), but it is agent-to-agent with Agent
   Cards and server discovery: too heavy for "a pipe from the CLI to ay", and
   no CLI agent speaks it.
4. **MCP channels** are Claude Code-only, interactive-only, unacknowledged and
   carry whole messages, no status and no deltas, though their permission
   relay is a good model for §12. Useful as one delivery path, not as the
   protocol. **SEP-3415** solves a neighbouring problem (typed events with
   cursors and dedup from an MCP server); the profile borrows its delivery
   rules (at-least-once, dedup by id, bounded replay, an explicit gap signal)
   rather than its methods.
5. **The three CLI JSON modes** (Claude, Codex, Gemini) are each vendor's own
   output format. ay already normalises Claude's into `AyEvent`
   (agent-yes `ts/stream/types.ts`); the protocol should be what that
   normalised form looks like on the wire.

## 3. Decision: a thin profile of ACP

**Adopt ACP's semantics and payloads; add only a multi-party JSON Lines
envelope.** We call it **ACP-channel profile v1** (`acp-channel/1`).

- Every payload that ACP already defines is carried **verbatim** in ACP's shape
  (`ContentBlock`, `SessionUpdate`, `RequestPermissionRequest` options and
  outcome, `StopReason`). Nothing is renamed. An endpoint that already speaks
  ACP converts by wrapping and unwrapping, never by translating fields.
- The envelope adds what ACP lacks for a chat: who sent it and to whom
  (`from`, `to`), a stable event `id` for dedup and receipts, `ts`, a
  per-stream `seq` cursor for resume, and three chat-only types (`message`,
  `ack`, `status`).
- A2A's task-state words are used for `status` where ACP has none
  (`working` = `TASK_STATE_WORKING`, `input-required` =
  `TASK_STATE_INPUT_REQUIRED`; `idle` has no A2A twin and means "no task
  running"), so a later A2A gateway is a mapping, not a redesign.
- **Native ACP is a mode of the same endpoint**, not a competitor: `ay channel
  --acp` speaks plain ACP JSON-RPC on stdio, so Zed or any ACP client can drive
  an ay-hosted agent, and an ACP agent (Gemini CLI's ACP mode, the Claude Code
  and Codex ACP adapters) can sit behind ay. The profile is for the chat
  bridge, where the multi-party envelope earns its keep.

Why not plain ACP JSON-RPC end to end: the Lianki side would have to be an ACP
**client** (one session, owned prompts, `id`-matched requests) while it is in
fact a multi-device chat that must relay several people and agents, survive
WebSocket reconnects and one-way SSE, and replay after a cursor. Wrapping ACP
in an event envelope keeps ACP's meaning and drops only its 1:1 call shape.

Why not invent: everything inside `payload` already has an ACP definition; the
envelope is a handful of fields. If ACP's remote transport (the Streamable
HTTP + WebSocket RFD, Draft) grows
multi-party addressing and resumable streams, this profile folds into it and
the envelope becomes the transport frame.

## 4. The event envelope

One event per line (JSON Lines: UTF-8, `\n`-terminated, no pretty-printing; a
line is at most 1 MiB; a line that does not parse is skipped and reported once
as `error` `bad-line`).

```json
{
  "v": "acp-channel/1",
  "id": "01JD6Q3VZ7M2B8Q8G1TQ4V8X2C",
  "seq": 42,
  "ts": "2026-11-27T09:14:03.512Z",
  "from": "user:primary",
  "to": "agent:repo-main",
  "type": "message",
  "re": null,
  "turn": null,
  "payload": { "content": [{ "type": "text", "text": "fix the failing test" }] }
}
```

| field     | required          | meaning                                                                                                                                                         |
| --------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v`       | on the first line, then optional | protocol and major version. A different major is refused (`error` `version`); a higher minor is read, unknown fields ignored                   |
| `id`      | yes               | unique per event, chosen by the sender (ULID or UUIDv7 recommended). Dedup key; a repeat `id` is dropped                                                       |
| `seq`     | on streams that resume | per-stream, per-direction, strictly increasing integer assigned by the sending endpoint. Resume says "after seq N" (§6). Not global, not across directions |
| `ts`      | yes               | RFC 3339 UTC with milliseconds, when the sender made the event                                                                                                 |
| `from`    | yes               | participant address, `kind:name`: `user:<name>`, `agent:<name>`, `system:<name>`. Names are the endpoint's local names, opaque to the other side               |
| `to`      | yes               | an address, an array of addresses, or `"*"` (everyone on the channel)                                                                                          |
| `type`    | yes               | the event type (§5). Unknown types are ignored (and never acked)                                                                                                |
| `re`      | for replies       | the `id` this event answers or refers to: an `ack`'s message, a `permission.response`'s request, a `delta`'s message, an `error`'s cause                         |
| `turn`    | inside a turn     | the turn id from `turn.start`; groups deltas, tool updates and the final message                                                                               |
| `payload` | yes (may be `{}`) | type-specific body, ACP-shaped where ACP defines it                                                                                                             |

Versioning:

- `acp-channel/<major>`; minors are additive (new optional fields, new event
  types) and are announced in `hello`, never in `v`.
- The first event each side sends is `hello`: `payload` `{ "endpoint":
  "ay/1.2.3", "acp": 1, "minor": 0, "capabilities": { "delta": true,
  "permission": true, "resume": true, "types": ["message", "..."] } }`. `acp` is
  the ACP `protocolVersion` the payloads follow. Each side uses only what both
  list (as ACP's `initialize`).
- Breaking changes bump the major; an endpoint may speak two majors and pick
  the highest both list.

## 5. Event types

Each row says who sends it, its payload and the ACP or A2A shape it reuses.

| type                  | sender → receiver | payload                                                                                                                         | reuses                                                                 |
| --------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `hello`               | both              | endpoint, versions, capabilities (§4)                                                                                           | ACP `initialize`                                                       |
| `message`             | both              | `{ content: ContentBlock[], final?: true, quiet?: true }`. From the chat: a user line. From the agent: a whole reply, or the final form of a streamed one (`re` = the first delta's id is not required; `turn` ties it) | ACP `ContentBlock`; A2A `Message.parts`                                |
| `delta`               | agent → chat      | `{ update: SessionUpdate }`, one of `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`        | ACP `session/update` verbatim                                          |
| `ack`                 | receiver → sender | `{ status: "received" \| "delivered" \| "queued" \| "read" \| "rejected", reason? }`, `re` = the acked event                      | chat receipts; ay send's exit codes (§9)                                |
| `status`              | agent side → chat | `{ state: "idle" \| "working" \| "input-required" \| "stuck" \| "offline", detail?, costUsd? }`                                | A2A `TaskState` words                                                  |
| `turn.start`          | agent → chat      | `{ cause?: <message id> }`; sets `turn` for what follows                                                                        | Codex `turn.started`                                                   |
| `turn.end`            | agent → chat      | `{ stopReason: "end_turn" \| "max_tokens" \| "max_turn_requests" \| "refusal" \| "cancelled", usage? }`                          | ACP `StopReason`                                                       |
| `turn.cancel`         | chat → agent      | `{}`; best effort, answered by `turn.end` `cancelled`                                                                           | ACP `session/cancel`                                                   |
| `permission.request`  | agent → chat      | `{ toolCall: ToolCallUpdate, options: PermissionOption[], expiresAt? }`                                                          | ACP `session/request_permission` params                                |
| `permission.response` | chat → agent      | `{ outcome: { outcome: "selected", optionId } \| { outcome: "cancelled" } }`, `re` = the request                                 | ACP `RequestPermissionResponse`                                        |
| `error`               | both              | `{ code, message, fatal: boolean, retryAfterMs? }`, `re` = the cause if any                                                     | JSON-RPC error codes where they fit                                    |
| `bye`                 | both              | `{ reason }`; the sender closes after it                                                                                        | —                                                                      |

Rules:

- **Deltas are disposable.** A receiver may drop, coalesce or never show them;
  the agent's `message` with `final: true` at the end of a turn carries the
  whole reply. A chat that shows only whole messages ignores `delta`. This is
  what keeps a slow phone or a rate-limited chat correct.
- **One permission request, one response.** First valid response wins; later
  ones get `error` `already-answered`. An expired or cancelled request is
  `reject_once` to the agent (fail closed), never "allow".
- `input-required` covers both a permission prompt and a free-text question
  (ay's `needs_input`); a question is a `message` from the agent plus
  `status` `input-required`, answered by an ordinary `message`.
- `ack` is never acked. `delta` is never acked. A `message` and a
  `permission.response` are acked by the receiving endpoint (`received`), and
  again when the agent actually took them (`delivered` or `queued`).

## 6. Transports

The same events on three carriers. An endpoint implements at least stdio.

| transport           | framing                                                       | direction                                     | resume                                                                     |
| ------------------- | ------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------- |
| **stdio**           | JSON Lines on stdin/stdout; logs on stderr only                | both, one process pair                        | none needed (one process lifetime); `hello` re-sent on restart              |
| **WebSocket**       | one event per text frame (no newline needed); `ping`/`pong` text frames for keepalive as the Lianki chat socket does | both                                          | client sends `{type:"resume", payload:{afterSeq}}` after `hello`           |
| **HTTP + SSE**      | `POST /events` with `application/jsonl` (one or more events) → `202` + acks; `GET /events` as `text/event-stream`, each SSE `data:` one event, SSE `id:` = `seq` | POST up, SSE down                             | standard `Last-Event-ID` header = last `seq` seen                           |

- stdio is the bridge's default and needs no ports, no auth, no network: the
  two processes are the user's own.
- WebSocket is for a remote chat endpoint (lianki.com's existing token socket
  can carry the profile as a new socket `mode`, phase 3).
- HTTP + SSE is for environments without WebSocket and for an ay endpoint
  exposed on the user's tailnet (`ay serve` already serves HTTP); it matches
  A2A's `message/stream` shape.
- The WebSocket and HTTP paths follow ACP's draft remote transport where it
  is settled (one endpoint, a session id header, WebSocket upgrade on the
  same path), so moving to it later changes framing, not events.
- Replay buffers are bounded (default 500 events or 10 minutes, whichever is
  smaller); past it the receiver gets `error` `resume-gap` and a fresh
  `status`, and the chat reads history the usual way (`lianki chat read
  --after-seq`).

## 7. Auth: each side keeps its own secrets

- **Lianki tokens stay on the Lianki side.** Only Lianki's endpoint (`lianki
  chat channel`, inside `packages/lianki-cli`) reads the token: `LIANKI_TOKEN`,
  the keychain or the 0600 file, exactly as `lianki chat listen` does today. It
  authenticates its WebSocket in the first frame, never in a URL, and never
  writes the token into an event. A `payload` that contains an `lk_…` string is
  refused before sending (the existing `withoutSecrets` check).
- **ay holds only what the user gives it.** ay's endpoint needs no Lianki
  credential at all on stdio. For WebSocket or HTTP it accepts a local bearer
  secret the user creates for ay (`ay channel --listen … --secret-file`), bound
  to loopback or the tailnet by default. It never receives, stores or forwards
  the Lianki token.
- **The bridge holds nothing.** A pipe between two stdio endpoints has no
  credential of its own.
- Token scope on the Lianki side is the existing chat scope (`chat:read`
  `chat:write` `chat:ask`), one token = one agent's name in the chat
  ([api-for-agents.md](api-for-agents.md), [lane-listen.md](lane-listen.md),
  "The lane token"). Permission prompts need no new scope: they are `ask`
  cards on the token's own thread. A token never evals, pairs or answers a
  card; only the user's tap does.

## 8. From a mention to the agent, and back

```text
user types "@repo-main fix the failing test" in Li
  → hub stores it, pushes {type:"chat", message:{id, seq, from:"owner"|"user", text, ...}} on the token socket
  → lianki chat channel: route check (lane-route matcher: is this line for this token's name?)
      no  → dropped (or, with --everyone, sent as FYI message with payload.fyi=true)
      yes → emits  {type:"message", from:"user:primary", to:"agent:repo-main", id:"lk-<msg id>", payload:{content:[text]}}
  → ay channel: acks received; delivers to the agent
      stream mode (Claude --stream): writes a stream-json user message, waits for ay's replay receipt → ack delivered
      PTY mode: same path as ay send (paste + Enter), exit 0/4 → ack delivered/queued, 1/3 → ack rejected
  → agent works: ay channel emits status working, turn.start, delta*, permission.request?, message final, turn.end, status idle
  → lianki chat channel:
      delta            → coalesced (≥ chat.channel.deltaMs) into one live "typing" line edited in place, or dropped
      message final    → op say as the token: an agent line 【repo-main】…
      status           → presence row (busy dot / idle / waiting)
      permission.request → op ask: a tap card in the user's Li window with the ACP options as buttons
      the tap (answered event) → permission.response back to ay → ay answers the agent's prompt
```

- The message `id` on the chat side is derived from the Lianki line id
  (`lk-<id>`), so a reconnect that replays the line produces the same event and
  ay drops it (dedup by `id`, kept for the replay window).
- Edits: a Lianki `edited` event for a line already delivered becomes a new
  `message` with `payload.supersedes` = the old event id; ay delivers it as a
  follow-up ("correction: …") and never rewrites what the agent already read.
- Voice: the existing turn assembly (`chat-receiver.mjs`: quiet gap, revision
  cap, optional cloud `prepare`) runs **inside Lianki's endpoint before** it
  emits `message`. ay sees only assembled turns.
- Friends' threads keep today's rule: an untrusted principal's message carries
  `payload.principal = {type: "friend", authority: "friend-chat-only"}` and ay's
  endpoint wraps it in the same "not authorisation" preamble that
  `chat-bridge.mjs` uses today.

## 9. The bridge

The adapter is two small endpoints, each in its own repo, joined by a pipe:

```bash
# one direction each, with a named pipe for the return path (POSIX)
mkfifo /tmp/acp-up
lianki chat channel --stdio --as repo-main < /tmp/acp-up \
  | ay channel --stdio --to . --cwd ~/code/repo > /tmp/acp-up
```

or, with no FIFO, ay's endpoint spawns the other side as a child:

```bash
ay channel --cwd ~/code/repo --peer "lianki chat channel --stdio --as repo-main"
```

(`--peer <cmd>` runs a peer endpoint as a subprocess and wires stdin↔stdout
both ways; Lianki's endpoint offers the same `--peer` so either can be the
parent.)

| endpoint                 | repo            | does                                                                                                                                          | does not                                    |
| ------------------------ | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `lianki chat channel`    | `snolab/lianki` (`packages/lianki-cli`) | token socket, routing, voice turn assembly, `message` out; `say` / `ask` / presence in; loop guard, rate limits on the chat side          | know what ay is; run any agent              |
| `ay channel`             | agent-yes       | find/attach the agent (`--to <keyword\|pid\|.>`), deliver (stream or PTY), turn agent output into `delta`/`message`/`status`/`permission.*`; `--acp` mode | know what Lianki is; hold a Lianki token    |

The existing `lianki chat listen --json` stays as it is (Lianki's own event
schema, not the profile); `lianki chat channel` is the profile endpoint, built
on the same socket code. `lianki chat listen --deliver` (which calls `ay send`)
stays for existing installs until phase 4.

## 10. Mapping: Lianki chat events → profile

What `lianki chat channel` reads from the token socket
(`workers/push/src/token-chat.ts`) and what it emits.

| Lianki socket event                                      | profile event                                                                                                     |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `ready`                                                  | `hello` (once) then `status` of the chat side is not sent; `ready` only opens the stream                         |
| `history` (`messages[]`)                                 | nothing by default; with `--history n`, each as `message` with `payload.history = true` (context, never a task)   |
| `chat` `message` `from: "owner"` / `"user"`, routed here | `message` `from: "user:primary"`, `id: "lk-<message.id>"`, `payload.content` = `[{type:"text",text}]` (+ `source: "voice"` when spoken) |
| `chat` `from: "agent"` (another agent)                   | dropped; with `--everyone` → `message` `payload.fyi = true` (never answered, §13)                               |
| `chat` from this token's own lane                        | dropped (echo)                                                                                                   |
| `edited`                                                 | `message` with `payload.supersedes`                                                                              |
| `answered` (a tap on this token's ask card)              | `permission.response` if the card was a permission card, else `message` (the chosen labels)                    |
| `sent` / `asked` (replies to our say/ask)                | `ack` `delivered` for the agent event they carried                                                               |
| `mute` `muted: true`                                     | `error` `muted` (fatal: false); agent events stop being posted until unmuted                                    |
| `error` `rate`                                           | `error` `rate-limited` with `retryAfterMs`                                                                      |
| `error` `unknown` / `expired` / `scope` / `blocked`, `revoked`, `expired` | `error` fatal, then `bye`                                                                                         |

And the other direction (profile → Lianki op):

| profile event from ay                 | Lianki op                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `message` (agent, final)              | `say` (`text` from the text blocks; other blocks summarised); `quiet` passed through              |
| `delta` `agent_message_chunk`         | coalesced into a live preview (new hub op `say` with `cut: "supersede"` on one draft id, phase 3); otherwise dropped |
| `delta` `tool_call` / `tool_call_update` | optional one-line quiet status ("running tests…"), at most one per `chat.channel.toolLineSec`   |
| `status`                              | presence row (`op: "lane"` grows `activity: idle\|working\|input-required\|stuck`)                |
| `turn.start` / `turn.end`             | presence only; `turn.end` `refusal` / `max_tokens` adds a quiet line                              |
| `permission.request`                  | `ask` with `question` from the tool call title/kind, `options` from `PermissionOption.name`, `expiresAt` |
| `error` (agent side)                  | a quiet line once per code per minute; fatal → presence `offline`                                 |

## 11. Mapping: ay states and events → profile

From agent-yes as it is today: the registry state of `ay ls --json` /
`ay ls --watch` (`LiveState`: `active | idle | needs_input | stuck | stopped |
unreachable`), the `--stream` mode's normalised events (`AyEvent`,
`ts/stream/types.ts`, Claude Code stream-json only for now), and `ay send`'s
exit codes.

| ay                                                  | profile                                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `LiveState` `active`                                | `status` `working`                                                                               |
| `idle`                                              | `status` `idle`                                                                                  |
| `needs_input` (with `question`)                     | `status` `input-required`, `detail` = the question; in PTY mode also `permission.request` when the screen is a known prompt (§13) |
| `stuck`                                             | `status` `stuck`                                                                                 |
| `stopped`, `unreachable`                            | `status` `offline`                                                                               |
| `AyEvent` `session`                                 | folded into `hello` `payload.session` (`sessionId`, `model`)                                     |
| `turn_start`                                        | `turn.start`                                                                                     |
| `user` (replay receipt of a sent message)           | `ack` `delivered` for that message                                                               |
| `text` `partial: true`                              | `delta` `agent_message_chunk`                                                                    |
| `text` (complete)                                   | buffered; emitted as `message` `final` at `turn_end`                                             |
| `tool_call`                                         | `delta` `tool_call` (`status: "in_progress"`)                                                    |
| `tool_result`                                       | `delta` `tool_call_update` (`status: "completed"` / `"failed"`)                                  |
| `needs_permission` (`reqId`, `tool`, `input`, `options`) | `permission.request` (`toolCall.toolCallId = reqId`, options mapped to ACP kinds)          |
| `needs_input` (`reqId`, `question`, `options?`)     | `message` (the question) + `status` `input-required`                                             |
| `turn_end` (`stopReason`, `usage`, `costUsd`)       | `turn.end` (+ `status` `idle` with `costUsd`)                                                    |
| `error` (`fatal`)                                   | `error` (`fatal` copied)                                                                         |
| `ay send` exit 0 / 4 / 1 / 3                        | `ack` `delivered` / `queued` / `rejected` (`not-submitted`) / `rejected` (`unreachable`)        |
| PTY mode, no `--stream`                             | no deltas; `message` final from the new lines of `ay read` between turn start and idle (best effort, marked `payload.scraped = true`) |

For Codex and Gemini the same table applies once ay's stream mode covers them:
Codex `exec --json` has no token deltas (`item.updated` is a snapshot, so ay
emits the new suffix as `agent_message_chunk`, or prefers `codex app-server`'s
`item/agentMessage/delta` and its `requestApproval` requests, which map to
`permission.request` with `accept`/`acceptForSession`/`decline` →
`allow_once`/`allow_always`/`reject_once`),
`item.started`/`item.completed` (`command_execution`, `file_change`) →
`tool_call`/`tool_call_update`, `turn.completed`/`turn.failed` → `turn.end`;
Gemini `message` `delta` → `agent_message_chunk`, `tool_use`/`tool_result` →
`tool_call`/`tool_call_update`, `result` → `turn.end`. An agent that speaks ACP
natively needs no table: ay wraps its `session/update` as `delta` as is.

## 12. Permission prompts in the user's Li window

- ay's endpoint emits `permission.request` only for prompts it can answer
  reliably: stream mode's `needs_permission` (a structured request with a
  `reqId`), an ACP agent's `session/request_permission`. In PTY mode it emits
  one only for prompts on its known-prompt list and only with options it can
  press; otherwise it sends `status` `input-required` with the screen line,
  and the user answers at the terminal.
- Lianki shows it as an `ask` card on the token's thread: the tool's title,
  the command or path (secrets redacted with the same `redact()` the stall
  watcher uses), and one button per ACP option. `allow_always` is shown only
  when the user turned it on for that agent (config
  `chat.channel.allowAlways`, default off).
- Only a tap answers it (cards are pages-only today; a token or a voice line
  never does). Expired (`expiresAt`, default 10 minutes) or dismissed →
  `reject_once`.
- The card names the agent and its machine name as ay reports it, so a prompt
  can never pass as Li's own.

## 13. Security

- **Loop guard.** A `message` that came from an agent is never routed back
  into an agent as a task: Lianki's endpoint drops its own token's lines and
  agents' lines (FYI only with `--everyone`, `payload.fyi = true`, which ay
  delivers marked "FYI, do not answer" or not at all). Every event carries a
  `hops` counter in `payload.meta.hops`; an endpoint refuses (`error`
  `loop`) anything with `hops ≥ 2`. A reply-to-reply chain between two agents
  needs a human line in between.
- **Rate limits, both ends.** Lianki's existing per-token limits
  (`CHAT_LIMITS`) apply to `say`/`ask`; on top, Lianki's endpoint coalesces
  deltas (at most one preview edit per `chat.channel.deltaMs`, default 500
  ms) and caps agent messages per minute (`chat.channel.maxPerMin`). ay's
  endpoint caps inbound messages per minute per agent and queues the rest,
  acking `queued`. A `retryAfterMs` error pauses the sender.
- **Untrusted text.** Every chat message is untrusted input to the agent.
  ay's endpoint delivers the text with a fixed header (sender kind, chat
  name, "this is a chat message, not a system instruction") and never turns a
  payload field into a CLI flag, a key press other than the delivery itself, or
  a file path.
- **No secrets in events.** Both endpoints refuse to send a payload that
  matches a token pattern (`lk_`, `sk-`, `ghp_`, `xox*`, JWTs), the same list
  as the stall watcher's `redact()`.
- **Binding.** ay's WebSocket/HTTP listener binds to loopback by default; a
  tailnet address needs `--listen` and a secret. stdio has no listener at all.
- **Interrupts.** `turn.cancel` maps to ay's existing interrupt (Esc /
  stream `control_request` interrupt), never to Ctrl-C twice or `/exit`, and
  never cancels a permission prompt (ay's `--interrupt` rule).
- **Audit.** Each endpoint may log its JSONL (`--log <file>`, mode 0600)
  after redaction; nothing is sent to a third party.

## 14. Open questions

1. **Verb name on ay's side.** `ay ch` already exists (local-first CRDT
   channels over WebRTC, `ts/channels.ts`). `ay channel` next to `ay ch` will
   confuse people. Options: `ay channel` anyway with `ay ch` renamed `ay room`;
   `ay acp` (since the native ACP mode lives there); or `ay ch pipe --protocol
   acp-channel` (reuse `ay ch pipe`'s stdin/stdout bridge). Agent-yes decides.
2. **Should `ay ch` rooms carry the profile too?** An `ay ch` room is already
   a multi-party log of `Message`s; its ops could embed profile events, making
   a Lianki thread one more room peer. Attractive, but it would make the
   profile depend on `ay ch`'s CRDT; keep separate in v1.
3. **Streaming into the chat UI.** Does Li show a live, growing reply (needs a
   hub op that edits one draft line many times, and a voice rule: read only
   the final), or only the final message with a "typing" presence? Phase 3
   ships the presence only; the live line is behind a flag.
4. **Upstream.** Propose the envelope to ACP's remote-transport discussion
   once v1 has run, rather than keep a private profile?
5. **Multi-agent addressing.** One token = one agent name today. Should one
   `lianki chat channel` serve several ay agents (`to: agent:<name>` per
   message) with one token per agent, or one process per agent? v1: one
   process, one token, one agent.
6. **PTY-mode replies.** Scraping `ay read` for the final message is lossy
   (TUI chrome, wrapped lines). Should v1 refuse PTY agents and require ay's
   stream mode (Claude only today) or an ACP agent?
7. **Claude Code channels.** For Claude Code, `notifications/claude/channel`
   delivers into a running interactive session without a PTY paste, and its
   permission relay (`claude/channel/permission`, `allow | deny`) would give
   PTY-mode Claude a structured `permission.request`. It is a research
   preview, needs a development flag for a custom channel and does not run
   with `-p`. Should ay ship a small channel MCP server and prefer it for
   interactive Claude sessions?
8. **Hosted ay.** When ay runs on a server (`ay serve`), may Lianki's Worker
   connect to it over HTTP/SSE directly (no local bridge), with the user's ay
   secret stored by Lianki? That would make Lianki hold an ay credential;
   against §7 as written.

## 15. Phased plan

ETAs in agent-minutes (one agent working; review and CI time not included).

| phase | what                                                                                                                                                  | repo        | ETA     |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------- |
| 0     | This spec; agent-yes maintainers review it; settle open question 1                                                                                    | both        | 30      |
| 1     | JSON Schema for the envelope and each `payload` (ACP schemas referenced by `$ref`), a conformance fixture set (JSONL in/out pairs), a 50-line reference echo endpoint for tests | spec folder, mirrored in each repo | 90–150 |
| 2a    | `ay channel --stdio` on top of `--stream` (Claude): message in, `delta`/`message`/`status`/`turn.*`/`permission.*` out, acks from replay receipts; fixtures pass | agent-yes   | 180–300 |
| 2b    | `lianki chat channel --stdio`: token socket → `message`; `message`/`status`/`permission.request` → `say`/presence/`ask`; loop guard, coalescing, rate caps; unit tests against the fixtures | lianki      | 180–300 |
| 3     | Bridge end to end on the owner's Mac behind a flag (`chat.agent-channel`, default on per flag rules, audience owner first): one lane moved from `lane-listen` to the pipe; Li presence shows `working`/`input-required`; permission card round-trip | lianki (+ ay release) | 120–240 |
| 4     | PTY-mode delivery and `--acp` mode in ay; Codex/Gemini stream normalisation; `lianki chat listen --deliver` points new installs at the pipe; docs for users in `/api/agent-guide` | both        | 300–600 |
| 5     | WebSocket and HTTP/SSE transports with resume; optional live-reply line in Li (open question 3)                                                       | both        | 240–480 |

Phases 2a and 2b run in parallel once phase 1's fixtures exist; neither
endpoint is tested against the other's code, only against the fixtures.

## 16. Sources

Read 2026-11-27.

- Agent Client Protocol: https://agentclientprotocol.com/protocol/overview,
  …/protocol/initialization, …/protocol/prompt-turn, …/protocol/tool-calls,
  …/protocol/transports, …/rfds/streamable-http-websocket-transport,
  …/get-started/agents
- Model Context Protocol, transports (revision 2026-07-28):
  https://modelcontextprotocol.io/specification/latest/basic/transports
- Claude Code channels: https://code.claude.com/docs/en/channels and
  https://code.claude.com/docs/en/channels-reference
- MCP SEP-3415, events extension:
  https://modelcontextprotocol.io/seps/3415-events-extension
- Claude Code headless / stream-json: https://code.claude.com/docs/en/headless
  and https://code.claude.com/docs/en/agent-sdk/typescript
- Codex: https://learn.chatgpt.com/docs/non-interactive-mode,
  https://learn.chatgpt.com/docs/app-server,
  https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs
- Gemini CLI headless: https://geminicli.com/docs/cli/headless/ and
  https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/output/types.ts
- A2A 1.0: https://a2a-protocol.org/latest/specification/
- Not verified: the exact `request.subtype` of Claude Code's permission
  `control_request` (believed `can_use_tool`) and the tail of SEP-3415.
- agent-yes (local checkout): README ("Inspect and message running agents"),
  `ts/stream/types.ts` (`AyEvent`), `ts/stream/state.ts`, `ts/stream/send.ts`,
  `ts/lsWatch.ts` (`LiveState`), `ts/channels.ts` (`ay ch`)
- Lianki: `workers/push/src/token-chat.ts`, `packages/lianki-cli/cli.mjs`
  (`chatSocket`, `cmdChatListen`), `packages/lianki-cli/chat-bridge.mjs`,
  `packages/lianki-cli/chat-receiver.mjs`, `scripts/dev/lane-listen.ts`
