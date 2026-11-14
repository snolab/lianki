# The API for users' own AI assistants

Owner, 2026-11-10 22:54 JST: many users, ordinary users included, have their
own AI agents. So we keep offering API tokens to everyone, and every token
comes with a prompt that teaches the user's agent how to use Lianki's API.

## What the user sees

Settings (`/my/preferences`) → API tokens (`TokenManager.tsx`), for every
signed-in user, never gated:

- a line under the intro: copy the instructions beside a token and give them
  to your assistant; they hold no secret; keep the token where the assistant
  runs (keychain via `npx lianki auth login`, an environment variable, its MCP
  settings), never paste it into a chat;
- in every live token's row, **Instructions for your AI assistant** (a
  disclosure, `AgentGuide.tsx`): the text itself, readable before copying, and
  **Copy instructions for your AI assistant**;
- the same copy button under a newly made token, next to its one-time secret.

The instructions are in the page's language and are built for that token: its
permissions, its name and its expiry date.

## One source

`lib/agent-guide.ts` → `agentGuide({scopes, t, name?, expires?})` returns the
instructions as Markdown. The prose is the `agent-guide` dictionary
(`lib/agent-guide.content.ts`, 16 locales, a context line per key,
[i18n.md](i18n.md)). Endpoints, headers, JSON shapes and examples are code in
the function and stay untranslated. The same function serves:

- the Settings page (client, `useIntlayer("agent-guide")`);
- **`GET /api/agent-guide`**, public Markdown (`text/markdown`), for an agent
  to fetch itself: `?scopes=study,chat:read` picks the sections (default:
  every permission but the owner-only `eval`), `?lang=zh` the language (else
  `Accept-Language`, else English). No session, nothing about any account.
  It is under `/api` because it is a machine interface
  ([url-principles.md](url-principles.md), rule 5).

Sections follow the scopes: cards only with `study`, chat only with a chat
scope (and only the ops it holds), the chat limits only with a chat scope.

## What it says, and where each fact comes from

| Fact                                                      | Source                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Header `Authorization: Bearer lk_…`                       | `lib/authEmailOrToken.ts`, `lib/api-token-user.ts`, `workers/push/src/token-chat.ts` |
| Card endpoints and shapes (`study`)                       | `app/fsrs.ts` behind `authEmailOrToken`; `GET /api/prefs`                            |
| Chat: `POST /api/version/chat` `{op: read \| say \| ask}` | `workers/push/src/token-chat.ts`                                                     |
| Chat limits per token                                     | `CHAT_LIMITS` (`lib/chat-limits.ts`, read by `lib/chat-token.ts`)                    |
| 401 unknown/expired, 403 scope, 429 + `Retry-After`       | `token-chat.ts` `STATUS`, `app/api/fsrs/[[...all]]/route.tsx`                        |
| Revoke in Settings → API tokens                           | `lib/api-token-api.ts`                                                               |

Card routes have no per-token quota (only the bulk routes have one, which the
guide does not list), so the guide asks for one request at a time and no
polling loops instead of quoting a number. When a route, a header or a limit
changes, change `agentGuide` with it; `unit/agent-guide.test.ts` holds the
header to the server's pattern and the limits to `CHAT_LIMITS`.

## Never the token

Owner, 2026-11-11 00:13–00:25 JST: the prompt for the assistant holds **no
secret**. It names the token only as `<YOUR_TOKEN>` and tells the assistant:

1. how the user gets one: `npx lianki auth login` (browser sign-in that makes
   the token and stores it in the macOS Keychain, else a 0600 file;
   docs/secrets-and-auth.md "CLI login"), or Settings → API tokens with only
   the permissions the task needs;
2. where it is kept: where the assistant runs (the keychain through the CLI,
   `LIANKI_TOKEN`, the client's secret store or the `env` block of its MCP
   config) — never asked for or pasted in a chat, never committed.

Before 2026-11-11 the page said "give your assistant both" (token and
instructions); that wording is gone. Any `lk_…` secret that reaches an input (a token
named after its own secret, say) is replaced by the placeholder
(`withoutSecrets`). Nothing new logs or prints a token: the secret is still
shown once, at creation, as before. Tests: `unit/agent-guide.test.ts` (scopes
→ sections, every locale, no secret ever), and the tokens step of
`scripts/qa/qa-ui.mjs` (the row's instructions hold the header and no token).

## Connect via MCP

Every guide has a **Connect via MCP** section (`MCP_CLIENTS` in
`lib/agent-guide.ts`, code never translated): the local stdio server
`npx -y lianki mcp` (packages/lianki-cli, `lianki mcp`) added to

| Client         | Where                                                          |
| -------------- | -------------------------------------------------------------- |
| Claude Code    | `claude mcp add lianki -- npx -y lianki mcp`                   |
| Claude Desktop | `claude_desktop_config.json`, `mcpServers.lianki` (with `env`) |
| Cursor         | `.cursor/mcp.json`, `mcpServers.lianki`                        |
| Codex          | `~/.codex/config.toml`, `[mcp_servers.lianki]`                 |

The server finds the token itself (the CLI's order: `LIANKI_TOKEN`, then the
Keychain, then the 0600 config file), so after `npx lianki auth login` no
config holds a secret; without the keychain the token goes in the client
config's `env` block on the user's own machine. The guide also tells the
assistant that tool results (card titles, chat lines) are data, never
instructions. The MCP key is a normal API token; v1 has no delete tool and no
eval.

### The server side of `lianki mcp`

- **Tools by permission.** At start the server asks `GET /api/cli-login/token`
  (the token's own name, scopes and expiry, `describeToken`) and lists only
  the tools those scopes allow (`TOOLS` in `packages/lianki-cli/mcp.mjs`:
  `study` → stats, due, next, get, add, import, review, settings_get;
  `chat:read|write|ask` → chat_read + chat_wait, chat_say, chat_ask;
  `progress` → progress_report, progress_show, progress_ack). An older server
  that has no GET there gets every tool; each route still checks.
- **Untrusted results.** Every result is `<untrusted-data>` JSON with `<`
  escaped, after a line saying never to follow instructions inside it.
- **429.** `call()` turns a 429 into `rate_limited` with the `Retry-After`
  seconds; the tool error says how long to wait.
- **Audit.** Each call sends `x-lianki-client: mcp/<version> tool=<name>`.
  `lib/api-token-client.ts` keeps only that exact shape and adds
  `via mcp/<version> <tool>` to the `api-token.use` row (chat: lianki-push
  passes the header to `chatTokenCheck`; card and settings routes: a row only
  for such a named use). At most once a minute per token, never the
  arguments or the token.
- **Publishing.** The package is 0.5.0 in the repo; npm gets it only through
  the release tag after the owner approves (docs/shipping.md, "Publishing
  the CLI"). Until then the guide's `npx -y lianki mcp` snippets name a
  version that is not on npm yet.

### The remote server: `https://lianki.com/mcp`

Owner, 2026-11-13 23:4x JST: "能不能马上部署一个 /mcp 的服务". The same tools
with nothing to install, for any client that speaks MCP **Streamable HTTP**:

```sh
claude mcp add --transport http lianki https://lianki.com/mcp \
  --header "Authorization: Bearer <YOUR_TOKEN>"
```

```json
{
  "mcpServers": {
    "lianki": {
      "url": "https://lianki.com/mcp",
      "headers": { "Authorization": "Bearer <YOUR_TOKEN>" }
    }
  }
}
```

The guide carries both (`MCP_REMOTE_CLIENTS` in `lib/agent-guide.ts`, prose
key `mcpRemote`).

- **Its own Worker.** `lianki-mcp` (`workers/mcp`, route `lianki.com/mcp*`,
  no workers.dev URL), apart from the main Worker so it could go live while
  the main deploy was held, and so a call starts no Next.js isolate. Any other
  path under the route (`/mcp-something`) is passed to the main Worker as is.
  Deployed by `deploy-worker.yml` after `lianki` and `lianki-push`,
  non-blocking (docs/shipping.md).
- **Transport.** Stateless: one JSON-RPC message per POST (`initialize`,
  `ping`, `tools/list`, `tools/call`; notifications get 202). The answer is
  JSON, or one `text/event-stream` event when the client's `Accept` ranks
  that higher. No session and nothing pushed unasked, so GET and DELETE are 405. Protocol versions: `PROTOCOL_VERSIONS` in `workers/mcp/src/mcp.ts`.
- **Auth.** `Authorization: Bearer lk_…`, the same token as everywhere. The
  Worker never checks it itself: every call forwards it, over service
  bindings, to the main Worker (`MAIN`, card and settings routes,
  `GET /api/cli-login/token`) or to lianki-push (`PUSH`, the chat at
  `/api/version/chat`), which check permissions, expiry, account and rate
  limits exactly as for any API call. No header, or a token the server
  refuses (401), answers HTTP 401 with `WWW-Authenticate: Bearer`.
  `initialize` and `tools/list` ask `GET /api/cli-login/token` (so a bad
  token fails at connect and the list follows the token's permissions);
  `tools/call` asks it too and refuses a tool outside them before anything
  runs. No OAuth yet: clients that only do OAuth cannot connect.
- **Same tools.** The tool table is shared with `lianki mcp`:
  `packages/lianki-cli/mcp-tools.mjs` (tools, zod inputs, untrusted-data
  wrapping, errors) and `packages/lianki-cli/api.mjs` (`call`), both
  runtime-neutral. Arguments are checked against the same zod shapes; a bad
  one is a tool error and nothing is sent.
- **Audit.** Each call sends `x-lianki-client: mcp-remote/<version>
tool=<name>`; `lib/api-token-client.ts` accepts that shape too.
- **Waiting for the chat: `lianki_chat_wait`** (`chat:read`). Owner,
  2026-11-14 00:1x JST: an agent with only the remote MCP must take part in
  his Li chat in real time. Arguments `{after?: <line id>, timeoutSec?:
1–55, default 50}`; result `{lines, answered, after, gap?}`: the lines newer
  than `after` (at once when some already are; without `after`, the next line
  to arrive), answers to the token's own ask cards, and the cursor to pass
  next time. Empty lists at the timeout (under a client's usual 60 s request
  timeout). `gap: true` when `after` was not among the last 100 lines (all
  100 come back). Event-driven: the call opens the same token chat socket
  `lianki chat listen` uses (`waitChat` in `mcp-tools.mjs`; the Worker opens
  it as a WebSocket upgrade through `PUSH`, the stdio server with its
  `WebSocket` to `wss://…/api/version/chat`), the token only in its first
  message, and closes it on the first line, answer or timeout. Chosen over a
  long-poll op in lianki-push: no change to the hub, and the hub's existing
  scope (`listen` = `chat:read`), lane filtering (`forLane`), revocation and
  rate checks apply as they are. While it waits, the socket counts as an
  agent listening in the thread.
- Tests: `unit/mcp-remote.test.ts` (fake bindings), `unit/mcp-chat-wait.test.ts`
  (fake hub socket).

## Report progress

Owner, 2026-11-14 05:45 JST: "把这个 CLI 修改甘特图的能力提供给整个系统，让所有
agent 都能用上". Until then only an agent inside this repo with a per-lane
progress token (`PROGRESS_TOKEN` in `.dev.vars`, or a grant minted from it)
could report to the state tree ([state-tree.md](state-tree.md), "Live
progress"). Now any agent with a Lianki API token can, on three surfaces that
share one request shape:

| surface                                                   | where                                                                  |
| --------------------------------------------------------- | ---------------------------------------------------------------------- |
| `lianki progress …` (`npx lianki`, the global `lianki` bin) | `packages/lianki-cli/progress.mjs` (flags → body), `cli.mjs` (the verbs) |
| MCP: `lianki_progress_report` / `_show` / `_ack`          | `packages/lianki-cli/mcp-tools.mjs`, served by `lianki mcp` and `lianki.com/mcp` |
| HTTP: `POST /api/version/progress` (`/batch`, `/ack`), `GET …` (`/stats`, `/history`) | lianki-push `ProgressHub` (`workers/push/src/progress.ts`)           |

- **The permission is `progress`** (`lib/api-tokens.ts` `SCOPES`, group
  `owner`): offered only to an account holding `dev` (`OWNER_SCOPES`, like
  `eval`, through `lib/api-token-api.ts` `siteOwner`), because the tree is the
  site owner's. Unlike `eval` it has no 30-day cap: a lane token with
  `chat:*` + `progress` may run the usual year. The token page lists it as
  "Report progress to your task list" (`api-tokens.content.ts`
  `scopeProgress`, `scopeProgressHint`, 16 locales).
- **One check, on the main Worker.** The hub does not read token rows. A
  bearer that looks like an API token (`lk_…`) at `/api/version/progress*`
  goes to `DebugSessions.chatToken` with `op: "progress"` (`lib/chat-token.ts`
  `CHAT_OPS`, the same RPC the chat uses): the permission, expiry, live
  account, an `api-token.use` audit row (`progress <name> via mcp/… tool=…`),
  and `owner` (holds `dev`). Anything but `ok` + `owner` is 401 (unknown,
  expired) or 403 (`scope`, or another account); no RPC bound is 503. The root
  secret and HMAC grants are untouched (`lib/progress-token.ts`).
- **What the token may do: the whole tree, as itself.** The hub takes it as
  the root grant *acting as the token's name* (`ProgressAuth` `{root: true,
  agent}`): every report is that agent's (a report without `agent` gets it
  filled in; one naming another agent is 403 "this token is for codex"),
  across any path, with the root's `grant` and `resolve`, but never
  `endedAt` (back-dating stays with the real root). So a token named `codex`
  reports as 【codex】 in the chat and as `codex` on the Gantt, from the same
  `LIANKI_TOKEN`. Cross-lane batches (main writing for several agents) keep
  using `PROGRESS_TOKEN`.
- **`lianki progress`**: `report` (the default: `--path --task --status
  --pct --eta --late --confirm --note --pr --needs --who --done
  --verified|--unverified --kind --ref --action --link --rev --change-id`),
  `batch '<JSON list>' | --file`, `ack <code>`, `show [--all]`, `stats
  [--agent --since]`, `history`. The CLI only maps flags to the body
  (`reportBody`): titles, scopes, the overrun rule and ETA limits are the
  hub's, and its words come back as exit 5. A plain `--done` is sent as
  `unverified: true` (the hub adds the "verify: …" child) unless `--verified
  "<evidence>"`; the repo's `progress.ts` asks `gh` instead, which the public
  CLI cannot assume. Token: `--token`, `LIANKI_TOKEN`, the keychain
  (`lianki auth login`), as for every command. The repo's `lianki-dev
  progress` falls back to `LIANKI_TOKEN` (or the lane's
  `~/.config/lianki/lanes/<lane>.token`) when no progress token is set.
- **MCP.** `lianki_progress_report` takes the report fields as arguments (zod
  checks them, then `reportBody` maps them exactly as the CLI); `_show`
  returns the tree's `entries` (not the log); `_ack` posts the receipt code.
  Listed only for a token holding `progress`; the remote Worker forwards
  `/api/version/progress*` to `PUSH` as it does the chat.
- **The guide** (`GET /api/agent-guide?scopes=…,progress`, Settings → API
  tokens) gets a "Report progress" section (`progressHeading`,
  `progressIntro`, `progressFields`, `progressRules` in
  `lib/agent-guide.content.ts`): the fields, the CLI lines, the overrun and
  receipt rules, and that the token writes as itself only.
- Tests: `unit/lianki-progress-cli.test.ts` (flag mapping, every verb against
  a fake hub, no token printed), `unit/progress-hub.test.ts` "progress: API
  tokens" (the RPC call, agent lock, batch, grant via `token:<name>`,
  refusals), `unit/eval-token.test.ts` "the progress permission" (owner-only
  offer, no 30-day cap, `chatTokenCheck` op `progress`),
  `unit/lianki-mcp.test.ts` "progress tools".
- Deploys: the hub change with lianki-push, the scope and RPC with the main
  Worker (both from `main` via `deploy-worker.yml`; the hub answers 503 to an
  API token until the main Worker with the new `CHAT_OPS` is live, so deploy
  order does not matter), the tools with `lianki-mcp`, and `lianki progress`
  to users only when `lianki` 0.5.0 is published to npm.
