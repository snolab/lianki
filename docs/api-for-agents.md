# The API for users' own AI assistants

Owner, 2026-11-10 22:54 JST: many users, ordinary users included, have their
own AI agents. So we keep offering API tokens to everyone, and every token
comes with a prompt that teaches the user's agent how to use Lianki's API.

## One-message sharing after creation

Owner, 2026-11-14: the newly created token box additionally offers **Copy AI
instructions + token**. This explicit action copies a single private message
with the localized, scope-filtered guide URL and `LIANKI_TOKEN=<secret>`.
The message is built in memory for the clipboard only, never logged, stored
or sent by the page. The ordinary instructions-only buttons and public guide
still contain no secret. Only the one-time creation box can include it.

The creation form also offers **Chat only**: it replaces the selected
permissions with `chat:read`, `chat:write`, `chat:ask`, removing study and eval.
The user still picks a name and expiry and taps Create.

## Chat by default, one additional permission at a time

New token forms in Preferences and CLI browser login initially select only
`chat:read`, `chat:write`, and `chat:ask` (`DEFAULT_TOKEN_SCOPES`). Existing
stored tokens keep their scopes. The public `/api/agent-guide` also defaults
to the chat sections; its explicit `?scopes=...` parameter still selects the
requested documentation.

Both MCP transports refresh the token's live permissions for tool discovery
and calls. Only tools allowed by those scopes are listed. Failed or malformed
permission introspection does not fall back to every tool. A known tool called
without its required permission returns structured `needScope` and `requestUrl`
fields; an unknown, expired or revoked token remains an authentication failure.

`requestUrl` points to
`https://lianki.com/my/tokens/scopes?token=<public-id>&scope=<one-scope>`.
The public ID is the stored token hash, never its bearer secret. Following this
link does not grant anything. The account that owns the token signs in and
explicitly approves that one scope; the page uses session-only
`GET/POST /api/token/scopes`. The token cannot approve itself. Foreign tokens,
invalid scopes, expired/revoked tokens and cross-site writes are refused.
Additional grants preserve existing scopes and expiry; developer-only scopes
still require a live `dev` grant and the existing expiry limits.

The assistant shows the link and waits. After approval it may refresh the tool
list and retry the requested operation. It must not click approval for the user
or broaden the request to other scopes. See [MCP scope requests](mcp-scopes.md).

## What the user sees

Settings (`/my/preferences`) → API tokens (`TokenManager.tsx`), for every
signed-in user, never gated:

- a line under the intro: copy the instructions beside a token and give them
  to your assistant; they hold no secret; keep the token where the assistant
  runs (keychain via `npx lianki auth login`, an environment variable, its MCP
  settings), or explicitly copy the combined private message after creation;
- in every live token's row, **Instructions for your AI assistant** (a
  disclosure, `AgentGuide.tsx`): the text itself, readable before copying, and
  **Copy instructions for your AI assistant**;
- the same copy button under a newly made token, next to its one-time secret.

The instructions are in the page's language and are built for that token: its
permissions, its name and its expiry date.

## The public guide: /guides/ai-apps

Owner, 2026-11-27: "can u make sure all users can use those mcp or ai identity
smoothly and be-guided". `https://lianki.com/guides/ai-apps` is a public page
(no session read, signed out works) for ordinary users: what a connected AI
app can do, step 1 on Lianki (make a token on `/my/mcp`, tick "Cards and
settings", copy its MCP connection URL), step 2 per app (ChatGPT, Claude,
Gemini, anchors `#chatgpt` `#claude` `#gemini`), staying in control, two
common problems, and other tools.

- Strings: `ai-apps-guide` (`app/(app)/guides/ai-apps/ai-apps-guide.content.ts`,
  16 locales, a context line per key). Lianki's own labels (`{page}`,
  `{tokens}`, `{study}`, `{create}`, `{copy}`, `{revoke}`) are filled at render
  from the `my-mcp` and `api-tokens` dictionaries, so the guide always names
  the buttons as the token page shows them. The other apps' menu names stay in
  English in quotes, with a note and the date they were checked
  (`AI_APPS_CHECKED_ON`, `lib/ai-apps-guide.ts`).
- "Who can use it" gives each app's limits only as its maker's help page states
  them (links in `AI_APPS`, checked 2026-11-27): ChatGPT, Business/Enterprise/Edu
  on the web, Pro read-only, no geo limit, work accounts added by owners/admins
  ("Plugins" → "+" → "Add custom MCP server", older "Workspace settings" → "Apps"
  → "Create"); Claude, every plan, Free one connector, the
  "Customize" → "Connectors" path, and "No sign in" as the Authentication choice
  while `mcp.oauth` is off ("+ Add" → "Add custom connector" → "Continue" twice →
  "No sign in" → "Add"); Gemini, 18+, US, personal account, History on, English
  only. ChatGPT steps follow OpenAI's plugin quickstart
  (developers.openai.com/plugins/quickstart): create the plugin, install it with
  "+", then a Work chat and @Lianki. The caveat sits right under the intro. It also
  says the app reaches Lianki only in a typed chat and never wakes itself, and that
  the help pages don't cover voice modes.
- Text steps only. The drafts' screenshots and videos came from the owner's
  account; they are not published.
- It uses the `/mcp/<token>` address with "No authentication", which works for
  every account today. OAuth (`mcp.oauth`, docs/mcp-oauth.md) is still off; when
  it is on, the ChatGPT/Claude steps can switch to the plain `/mcp` address.
- Linked from the API tokens section (`appsGuide`, on `/my/preferences` and
  `/my/mcp`), the `/my/mcp` "Connection guide" link, the browser page at
  `lianki.com/mcp` (`workers/mcp/src/guide.ts`) and the agent guide's MCP
  section (`mcpApps`). Test: `unit/ai-apps-guide.test.ts`.

## One source

`lib/agent-guide.ts` → `agentGuide({scopes, t, name?, expires?})` returns the
instructions as Markdown. The prose is the `agent-guide` dictionary
(`lib/agent-guide.content.ts`, 16 locales, a context line per key,
[i18n.md](i18n.md)). Endpoints, headers, JSON shapes and examples are code in
the function and stay untranslated. The same function serves:

- the Settings page (client, `useIntlayer("agent-guide")`);
- **`GET /api/agent-guide`**, public Markdown (`text/markdown`), for an agent
  to fetch itself: `?scopes=study,chat:read` picks the sections (default:
  `chat:read`, `chat:write`, `chat:ask`), `?lang=zh` the language (else
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

## Instructions-only copies never include the token

Owner, 2026-11-11 00:13–00:25 JST: the prompt for the assistant holds **no
secret** (the explicit one-message creation action above is the later exception). It names the token only as `<YOUR_TOKEN>` and tells the assistant:

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

Web apps that cannot paste a token (ChatGPT's custom connectors, Claude.ai)
connect to the remote server `https://lianki.com/mcp` by OAuth sign-in instead,
behind the flag `mcp.oauth`: [mcp-oauth.md](mcp-oauth.md).

### Explicit read acknowledgements and sequence recovery

A chat line carries its current version `seq`. Agents can read incrementally with
`POST /api/version/chat` `{op:"read", afterSeq, throughSeq?}` and keep the returned
coverage metadata. After actually consuming lines, an agent may explicitly send
`{op:"read-ack", lastReadSeq}` (`chat:read`), use `lianki chat seen --seq N`, or call
`lianki_chat_seen`. Reading/listening itself never sends that acknowledgement.
See [recovery, read semantics and costs](chat-seq-receipts.md).

### An agent's picture in the chat

An agent that joins the user's chat (an API token, `lianki mcp`, the remote
MCP) shows a generated mark from its token's name until it sets its own:
`lianki_chat_avatar` (MCP) or `lianki chat avatar <file.svg|->` (CLI), both
`op: "avatar"` with `chat:write`. The picture is **plain SVG text, never a
link**, at most 4 KB; the server keeps only `svg g path circle ellipse rect
line polyline polygon text tspan title`, geometry, plain colours (no `url()`,
no `var()`), `transform`, `opacity`, `font-size`, `text-anchor`, and drops the
rest (named in the answer's `dropped`). `svg: null` removes it. Lines through
an MCP client show an "MCP" badge. The account's owner can rename the agent,
change its picture or remove it (revoking its token) from the chat's
participant list.

### The server side of `lianki mcp`

- **Tools by permission.** At start the server asks `GET /api/cli-login/token`
  (the token's own name, scopes and expiry, `describeToken`) and lists only
  the tools those scopes allow (`TOOLS` in `packages/lianki-cli/mcp.mjs`:
  `study` → stats, due, next, get, add, import, review, settings_get, settings_set;
  `chat:read|write|ask` → chat_read + chat_wait, chat_say + chat_avatar, chat_ask;
  `progress` → progress_report, progress_show, progress_ack). The scopes are
  refreshed for discovery and calls; failed introspection exposes no tools.
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

### Clients without Authorization headers

[ChatGPT web supports No authentication](https://developers.openai.com/api/docs/guides/custom-mcp-server).
In Preferences → API tokens, create a dedicated, expiring token with only the
permissions you need. In its one-time secret box, use **Copy MCP connection URL**
(no manual URL assembly). Then configure `https://lianki.com/mcp/<TOKEN>` with **No authentication**. Substitute
the complete `lk_…` secret locally; never paste that address into chat or logs.
Only the exact `lk_` + 64 lowercase hexadecimal format is accepted in the path.
This uses the same live token introspection, scopes, expiry and revocation as
Bearer requests. Conflicting header and path credentials are rejected. The
canonical `/mcp` endpoint continues to accept Bearer authentication.

Browser GETs show the canonical connection guide without echoing the secret,
with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. RPC responses
redact API token strings, including upstream errors. Nested invalid MCP paths
are refused locally instead of forwarded to the app. Monitor path grouping
collapses the entire credential namespace to `/mcp/:token`.

[Cloudflare invocation logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#invocation-logs)
and tail events include raw request URLs, so this
Worker disables persisted logs (including invocation logs), tracing and its tail consumer. Do not enable
live tail or add request-URL logging on this Worker while using token addresses.
Client history and any external HTTP logging remain outside application
redaction; treat the whole address as a password. Prefer the Bearer endpoint
when the client supports headers.

## Report progress

Owner, 2026-11-14 05:45 JST: "把这个 CLI 修改甘特图的能力提供给整个系统，让所有
agent 都能用上". Until then only an agent inside this repo with a per-lane
progress token (`PROGRESS_TOKEN` in `.dev.vars`, or a grant minted from it)
could report to the state tree ([state-tree.md](state-tree.md), "Live
progress"). Now any agent with a Lianki API token can, on three surfaces that
share one request shape:

| surface                                                                               | where                                                                            |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `lianki progress …` (`npx lianki`, the global `lianki` bin)                           | `packages/lianki-cli/progress.mjs` (flags → body), `cli.mjs` (the verbs)         |
| MCP: `lianki_progress_report` / `_show` / `_ack`                                      | `packages/lianki-cli/mcp-tools.mjs`, served by `lianki mcp` and `lianki.com/mcp` |
| HTTP: `POST /api/version/progress` (`/batch`, `/ack`), `GET …` (`/stats`, `/history`) | lianki-push `ProgressHub` (`workers/push/src/progress.ts`)                       |

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
  the root grant _acting as the token's name_ (`ProgressAuth` `{root: true,
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

### Publish a private mini app and reference it in chat

An agent with **both `apps:publish` and `chat:write`** may POST `{manifest,html}`
to `/api/my/mini-apps`, or use `lianki app publish --manifest ./manifest.json
--html ./index.html` / MCP `lianki_app_publish`. The publishing permission is
opt-in: use the normal single-scope approval flow. The app belongs only to the
token account. Publication never grants runtime capabilities or makes an app
public. Mention `/m/<slug>` in chat or send `attachments:[{type:"app",slug}]`
with a `say` message to show its card; opening it uses the sandbox and per-app
capability prompts. See [mini apps](mini-apps.md).
