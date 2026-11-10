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

| Fact | Source |
| ---- | ------ |
| Header `Authorization: Bearer lk_…` | `lib/authEmailOrToken.ts`, `lib/api-token-user.ts`, `workers/push/src/token-chat.ts` |
| Card endpoints and shapes (`study`) | `app/fsrs.ts` behind `authEmailOrToken`; `GET /api/prefs` |
| Chat: `POST /api/version/chat` `{op: read \| say \| ask}` | `workers/push/src/token-chat.ts` |
| Chat limits per token | `CHAT_LIMITS` (`lib/chat-limits.ts`, read by `lib/chat-token.ts`) |
| 401 unknown/expired, 403 scope, 429 + `Retry-After` | `token-chat.ts` `STATUS`, `app/api/fsrs/[[...all]]/route.tsx` |
| Revoke in Settings → API tokens | `lib/api-token-api.ts` |

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

| Client         | Where                                                         |
| -------------- | ------------------------------------------------------------- |
| Claude Code    | `claude mcp add lianki -- npx -y lianki mcp`                  |
| Claude Desktop | `claude_desktop_config.json`, `mcpServers.lianki` (with `env`) |
| Cursor         | `.cursor/mcp.json`, `mcpServers.lianki`                       |
| Codex          | `~/.codex/config.toml`, `[mcp_servers.lianki]`                |

The server finds the token itself (the CLI's order: `LIANKI_TOKEN`, then the
Keychain, then the 0600 config file), so after `npx lianki auth login` no
config holds a secret; without the keychain the token goes in the client
config's `env` block on the user's own machine. The guide also tells the
assistant that tool results (card titles, chat lines) are data, never
instructions. The MCP key is a normal API token; v1 has no delete tool and no
eval.
