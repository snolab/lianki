# lianki

The command-line client for [Lianki](https://lianki.com), a spaced-repetition
app (FSRS). Review cards, add pages, change your settings, from a terminal or
from an agent.

```bash
bunx lianki --help      # or: npx lianki --help
```

Plain JavaScript (ESM) for Node.js 18 or newer, or Bun. No build step, one
dependency (`yargs`).

## Install

Run it without installing (`bunx lianki …` / `npx lianki …`), or install it:

```bash
bun add -g lianki       # or: npm install -g lianki
lianki --version
```

## Sign in

```bash
lianki auth login
```

This opens lianki.com in your browser. Sign in there if you are not already,
check the page, tick the token's permissions, pick when it expires, and press
**Approve**. The page sends a one-time code back to
the CLI (on `127.0.0.1`), and the CLI trades it for an API token named
`lianki CLI <your computer>`. The token itself is never put in a URL.

Where the token is kept:

- **macOS:** the Keychain (service `lianki-cli`).
- **Elsewhere**, or if the Keychain refuses: `~/.config/lianki/cli.json`,
  readable only by you (mode 0600).

The CLI never prints the token.

```bash
lianki auth status      # who you are signed in as
lianki auth logout      # revoke the token on the server and forget it
```

### Without a browser (servers, CI, agents)

Make a token at [lianki.com/my/preferences](https://lianki.com/my/preferences)
→ **API tokens** (a name, its permissions, an expiry), then either:

```bash
export LIANKI_TOKEN=lk_…                  # used by every command; nothing stored
lianki auth login --token - < token.txt   # or store it (stdin keeps it out of shell history)
```

`--token lk_…` on any command works too. Order: `--token`, then
`LIANKI_TOKEN`, then the stored token.

## Review

```bash
lianki next                             # the next due card: url and title
lianki review <url> good                # again | hard | good | easy (or 1–4)
lianki due --limit 5                    # the most overdue cards
lianki add https://example.com/article --title "Example"
lianki get <url>                        # one card (exit 3 if there is none)
lianki move <old-url> <new-url>         # the page moved
lianki delete <url> --yes               # without --yes it asks (in a terminal only)
lianki stats                            # how many cards, how many due
```

A review loop in a shell:

```bash
while url=$(lianki next --json | jq -er .data.card.url); do
  open "$url"; read -p "again/hard/good/easy: " r; lianki review "$url" "$r"
done
```

## Tokens: permissions and expiry

Like GitHub's fine-grained tokens, every token belongs to the account that
made it, acts only as that account, has only the permissions picked when it
was made, and expires (at most a year; there is no "never"). The token page
shows each token's permissions, expiry and last use, with one-click Revoke.

| permission   | lets the token                                              |
| ------------ | ----------------------------------------------------------- |
| `study`      | review, add and change cards; read and change your settings |
| `chat:read`  | read and follow your own chat (`chat read`, `chat listen`)  |
| `chat:write` | post in your own chat (`chat say`)                          |
| `chat:ask`   | post question cards in your own chat (`chat ask`)           |

No token can run code, pair a device, answer a card or reach another
account's chat.

## Chat

Your own chat thread only: your Learning Partner's. Lines show the token's
name as 【name】. Only your own tap on lianki.com answers a question card.

```bash
lianki chat say "finished chapter 3"
echo "from a script" | lianki chat say -
lianki chat ask --q "Review now?" --opt Yes --opt Later --recommend 1 --wait
lianki chat read --limit 20
lianki chat listen --json        # one JSON line an event, until Ctrl-C
```

`listen` and `ask --wait` need Node.js 22+ or Bun (a WebSocket). An agent
uses its own token: `LIANKI_TOKEN=lk_… lianki chat say …`; the line shows that
token's name.

## Settings

The settings that follow your account (the ones the app syncs between your
devices):

```bash
lianki settings list                         # every setting and its value
lianki settings get chat-voice.rate
lianki settings set words.readAloud true
lianki settings set chat-voice.rate 1.25
lianki settings set nav-pins.pinned '["/words","/reader"]'
```

A value is read as JSON when it parses (`true`, `1.25`, `["/words"]`), and as
a plain word otherwise (`light`). The server checks it; an invalid value
exits 5.

## MCP: use Lianki from your AI app

`lianki mcp` runs a local MCP server (stdio) for Claude Code, Claude Desktop,
Cursor, Codex and any other MCP client. Sign in once with `lianki auth login`
(the token goes to the Keychain); the server finds it there, so no config
file holds a secret.

```bash
claude mcp add lianki -- npx -y lianki mcp          # Claude Code
```

```json
{ "mcpServers": { "lianki": { "command": "npx", "args": ["-y", "lianki", "mcp"] } } }
```

(Claude Desktop: `claude_desktop_config.json`; Cursor: `.cursor/mcp.json`.)
Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.lianki]
command = "npx"
args = ["-y", "lianki", "mcp"]
```

Without the Keychain, add `"env": { "LIANKI_TOKEN": "lk_…" }` to the server's
entry, in the config file on your own computer. Never paste the token into a
chat.

| tool                  | permission   | what it does                                   |
| --------------------- | ------------ | ---------------------------------------------- |
| `lianki_stats`        | `study`      | how many cards, how many due                   |
| `lianki_due`          | `study`      | the due cards (`limit`)                        |
| `lianki_next`         | `study`      | the next card to review                        |
| `lianki_get`          | `study`      | one card by `url`                              |
| `lianki_add`          | `study`      | save a page as a card (`url`, `title`)         |
| `lianki_import`       | `study`      | save up to 100 pages (`items`)                 |
| `lianki_review`       | `study`      | record a review (`url`, `rating` 1–4)          |
| `lianki_settings_get` | `study`      | the settings, or one (`key`)                   |
| `lianki_chat_read`    | `chat:read`  | the latest chat lines                          |
| `lianki_chat_wait`    | `chat:read`  | wait (≤55 s) for the next line (`after`)       |
| `lianki_chat_say`     | `chat:write` | post a line                                    |
| `lianki_chat_ask`     | `chat:ask`   | post a question card; only your tap answers it |

Only the tools your token allows are listed. There are no delete tools.
Results are marked as untrusted data (page titles and chat lines can be
written by anyone), and the tools tell the model never to follow
instructions found in them. Each call is in your account's audit log as
coming through MCP, with the tool's name (never its arguments).

## Help

`lianki --help` is a short list of commands. Each command explains itself:

```bash
lianki review --help
lianki settings set --help
```

## For agents

- **`--json`** on every command. Success prints one line to stdout:
  ```json
  {"v":1,"ok":true,"command":"next","data":{"card":{"url":"https://…","title":"…"}}}
  ```
  Failure prints one line to **stderr**, and nothing to stdout:
  ```json
  {"v":1,"ok":false,"error":{"code":"auth_required","message":"not signed in to lianki.com","hint":"lianki auth login …"},"exit":2}
  ```
- **No prompts without a terminal.** When stdin is not a TTY nothing waits
  for input: `delete` needs `--yes`, and `auth login` asks for `LIANKI_TOKEN`
  or `--token -` instead of opening a browser (`--browser` opens it anyway).
- **Another site:** `--api https://…` or `LIANKI_URL` (default
  `https://lianki.com`).

### Exit codes

| code | meaning                                          | `error.code`                                                   |
| ---- | ------------------------------------------------ | -------------------------------------------------------------- |
| 0    | ok                                               |                                                                |
| 1    | usage: bad command, option or value              | `usage`                                                        |
| 2    | not signed in, or the token was refused          | `auth_required`, `auth_refused`, `auth_invalid`, `auth_failed` |
| 3    | no such card                                     | `not_found`                                                    |
| 4    | network or server error                          | `network`, `server`, `internal`                                |
| 5    | the server refused it (invalid value, rate limit) | `refused`, `rate_limited` (429; the message says how long to wait) |

### `data` by command (schema `v: 1`)

| command         | `data`                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `next`          | `{ card: { url, title } \| null }`                                                             |
| `due`           | `{ cards: [{ url, title, due, state, reps, lapses }] }` (`due` is an ISO time)                 |
| `review`        | `{ url, rating, interval, due, next: { url, title } \| null }` (`interval` like `"3d"`)        |
| `add`           | `{ url, title, due, options: [{ rating, interval }] }`                                         |
| `get`           | `{ url, title }`                                                                               |
| `delete`        | `{ url, deleted: true, next }`                                                                 |
| `move`          | `{ from, to, moved: true }`                                                                    |
| `stats`         | `{ cards, due }`                                                                               |
| `auth login`    | `{ site, email, tokenName, storage }` (browser) or `{ site, user, storage }` (token)           |
| `auth status`   | `{ site, signedIn, source, account, tokenName }`; `source` is `keychain`, `file`, `env`, `flag`, `stdin` or `legacy-file` |
| `auth logout`   | `{ site, revoked, forgotten }`                                                                 |
| `settings list` | `{ settings: { <key>: value \| null } }`                                                       |
| `settings get`  | `{ key, value }`                                                                               |
| `settings set`  | `{ key, value }`                                                                               |
| `chat say`      | `{ id, lane }`                                                                                 |
| `chat ask`      | `{ id, askId, lane, answer: null }`, or with `--wait` `{ id, askId, answer: { choices, labels, at } }` |
| `chat read`     | `{ thread, lane, messages: [{ id, from, label, text, at, ask?, answer? }] }`                  |

Within `v: 1` fields are only ever added; removing or renaming one bumps `v`.

## Agent chat workflow (unreleased)

`send` aliases `say`, including `-` for stdin. `read` fetches bounded history;
plain `listen` remains the existing event stream. Each command uses only the
account represented by its existing Lianki token.

```bash
lianki chat read --limit 30 --json
lianki chat listen --history 12 --json
lianki chat send "Working on the button now"
lianki chat prepare "Please fix the button" --json
lianki chat listen --deliver . --cwd /path/to/assistant
```

`listen --deliver` and `chat bridge` compose receiving, lightweight turn
preparation and delivery through `ay`, for any supported assistant. The CLI
builds a continuous voice run before waking the assistant: 1.2 seconds of
quiet, at most six seconds, 24 revisions or 6,000 characters. These are env
config defaults in `chat-receiver.mjs`. Urgent stop/cancel messages immediately
discard pending speech and are delivered at once. An assistant reply or typed
message is a hard boundary. History is context only; IDs deduplicate live
messages, and edits replace the corresponding full text. No automatic reply
is posted. The handoff uses `lianki.chat.agent.v1` and includes a `chat send`
reply command, authoritative raw text, every buffered revision and any
separately labelled polish suggestion. A slow UI polish never delays delivery.

Cloud preparation is the default for composed listening. The new authenticated
`POST /api/version/chat {op:"prepare",input}` requires both `chat:read` and
`chat:write`, with an independent authentication quota. The push Worker sends
only the authenticated user ID to `SESSIONS.prepareChatTurn`. The main Worker
uses the existing Cloudflare DeepSeek Flash provider with reasoning disabled,
a fixed JSON prompt and the same credit hold/settle/refund system. It does not
change Learning Partner replies or their refusal to answer developer accounts.
No local Cloudflare key is required. Body-supplied identities, models, prompts
and URLs cannot choose the payer or provider. The model sees only bounded text
and recent context, never grants, paths, audio, attachments or account tokens.

One fixed model call classifies household/background speech, identifies turn
boundaries and suggests punctuation/stutter cleanup. `polishCheck` rejects
semantic drift, including removed negations. Only a high-confidence unrelated
verdict suppresses a turn. Unavailable RPC, no credits, invalid results, limits
and timeouts report `prepare-unavailable` and forward the assembled raw turn.
`--ai off` disables cloud calls and keeps bounded raw assembly. `chat prepare`
uses credits but posts no chat messages. The `chat.prepare` ledger feature and
`chat.prepare*` live config keys are separate from replies: default model
budgets are 60 calls/account/10 minutes and 200 calls/site/day. The site cap can
be reached early; it is not automatically raised. Duplicate/unfunded requests
never consume the model-attempt budgets. Input is limited to 9,000 total
characters and role enums; the hold counts serialized JSON/framing as well.

For an existing grant receiver, use one stream and aggregate **before** routing:

```bash
bun scripts/dev/eval.ts chat --no-pair |
  bun packages/lianki-cli/lianki.mjs chat bridge --stdin --deliver . --cwd /path/to/assistant
```

Do not put `eval.ts --route chat` before this pipeline: only the first fragment
may name the intended assistant. Give the assembled handoff to one dispatcher,
which can use the existing `lib/lane-route.ts` matcher on its complete text.
Configure `--deliver`/`--cwd` for that dispatcher and let it choose the target.
Keep competing responders for the same thread off. The CLI never starts,
stops or replaces another listener. `--stdin` trusts its input transport and
limits it to `owner` by default; `--thread <id>` explicitly selects another
trusted input stream. Direct sockets derive their scope from authentication.

Optional active history cleanup is deliberately narrower than preparation:

```bash
bun scripts/dev/eval.ts chat --no-pair |
  bun packages/lianki-cli/lianki.mjs chat bridge --stdin --deliver . \
    --cwd /path/to/assistant --polish --grant-repo /path/to/checkout
```

Only this explicit owner-grant path writes messages. It calls existing
`eval.ts edit --no-pair` or `edit --merge` with ordered IDs, verifies the returned
ID/text/run, and preserves the existing identity, recent-message, settled
speech, consecutive-run, raw and undo guards. Rejected writes emit
`polish-refused`; raw remains the task authority. There is no summary fallback
or relaxed word guard. Ordinary account tokens get suggestions only, never a
new edit capability. Expected self-edits are registered before the request,
so a broadcast before its acknowledgement cannot cause another task. The echo
cache is bounded to 64 fingerprints/60 seconds. UI writes run in parallel;
on shutdown, the CLI aborts its own pending subprocesses, with a 15-second
transport deadline as a backstop. An already applied server edit retains undo.

The optional `--filter-service http://127.0.0.1:5196/v1/filter` adapter is for
local testing, not the default provider. `scripts/dev/chat-filter-service.ts`
uses inherited Cloudflare credentials and a separate
`LIANKI_CHAT_FILTER_TOKEN` for loopback authentication. The account token is
never sent there. Without provider configuration it is unavailable; it creates
no credentials. The default cloud path needs no such adapter.

The new cloud operation must be reviewed and deployed before it can run;
this source change does not enable it in production or switch any listener.
Run `bun --no-env-file scripts/dev/chat-filter-smoke.ts` with an existing
inherited account token after deployment approval. It sends only synthetic
cases, posts nothing, and prints status/latency. Missing auth or an undeployed
operation reports blocked. Private recordings have not been used for testing.
Local regression suites use stub providers and local databases.

The provider deadline defaults to 5 seconds (`chat.prepareTimeoutMs`, configurable
from 200 ms to 10 seconds). The bridge waits 6.5 seconds by default, including
hub, billing and transport overhead; `LIANKI_CHAT_BRIDGE_TIMEOUT_MS` may lower it
or raise it to 12 seconds when the server deadline is raised. Responses return
as soon as ready; there are no automatic model retries. A lower bridge deadline
can abandon a call that the server still completes and settles.

Provider failures return safe error categories (`provider-timeout`,
`provider-http` with numeric `status`, `provider-network`,
`provider-invalid-json`, `provider-invalid-response`, `provider-refused`), without
provider response bodies or exception messages. The model may return plain JSON
or one complete `json` code fence; surrounding prose is rejected. The bridge
retains those categories and distinguishes its own `prepare-timeout`,
`prepare-http` and `prepare-invalid-json`, forwarding the original turn on failure.

The bridge's `LIANKI_CHAT_BRIDGE_*` defaults and turn assembler's
`LIANKI_CHAT_TURN_*` defaults are env-overridable within their protocol maxima
(the request timeout has the separate 12-second ceiling above);
see their registries for names. For example, `LIANKI_CHAT_TURN_QUIET_MS` sets
the quiet window. Use the installed CLI or `bun packages/lianki-cli/lianki.mjs`;
`lianki-dev` has a separate flag parser. Publication, deployment and a live
listener switch remain separate review/approval steps.

### Friend threads from an existing authorized grant stream

Public account tokens remain restricted to their own thread. A trusted grant
stream can instead use an explicit reply transport for one friend:

```bash
bun scripts/dev/eval.ts chat --no-pair |
  bun packages/lianki-cli/lianki.mjs chat bridge --stdin --thread FRIEND_ID \
    --reply-transport grant --grant-repo /path/to/checkout --deliver . --cwd /path/to/assistant
```

For all friend threads, replace `--thread FRIEND_ID` with `--friends`. This
excludes the owner and gives each friend its own assembler, deduplication
records and lightweight-model context. Replies use only the existing
`eval.ts say --no-pair --to FRIEND_ID` grant transport, whose server checks
the actual target. Non-owner stdin without this explicit transport is refused,
so a reply cannot silently go to the owner's account. No new public-token
cross-account capability is added. A real voice `source: stt` is retained only
from the authenticated page's validated message; the CLI never guesses it.
Assistant lines are context only, and owner speech is never a friend request.

These handoffs carry a trusted `principal` with `authority: friend-chat-only`.
A friend's request authorizes only a chat reply to that fixed destination,
never owner-local tools, repositories, history, deployments or other accounts.
Friend taps are marked as friends, never as owner approvals. This restriction
applies to an owner-operated grant relay; a normal user's own direct-token
assistant workflow is unchanged. Per-thread payload/context isolation does
**not** create separate model sessions in a shared terminal. Use separately
isolated recipients if that stronger boundary is required.

The inbox has bounded defaults (`INBOX_DEFAULTS`): 64 active thread states and
30-minute idle expiry. Only idle states may expire; reaching capacity fails
explicitly rather than silently merging users or dropping a pending turn.
`LIANKI_CHAT_INBOX_MAX_THREADS` and `LIANKI_CHAT_INBOX_IDLE_TTL_MS` can lower the
defaults. Cloud preparation uses the relay's existing authenticated account
and credits; the friend thread ID cannot select a different payer. Ordinary
token owners still cannot read or write a different person's thread.

## Changes in 0.4.0

- New: `lianki mcp`, a local MCP server with tools for cards, settings and
  chat, listed by the token's permissions; no deletes.
- A 429 exits 5 with `error.code` `rate_limited` and says how long to wait.

## Changes in 0.3.0

- New: `chat say | ask | read | listen`, in your own chat thread.
- `auth login`: the approval page asks for the token's permissions and expiry.
- A token refused for a missing permission says so (exit 2, `auth_refused`).

## Changes in 0.2.0

- `auth login | status | logout`: sign in through the browser; the token goes
  to the Keychain. `login [token]`, `logout` and `whoami` from 0.1 are gone. A
  token that 0.1 saved in `~/.config/lianki/config.json` still works until
  `lianki auth logout`.
- New: `settings list | get | set`, `stats`.
- `--json` envelope, exit codes 3–5, and `delete` asks first.
- The default site is `https://lianki.com` (was `www.lianki.com`).
- `export` and `import` are gone: those endpoints take a browser session
  only now. Export from [lianki.com/data](https://lianki.com/data).

## Licence

MIT
