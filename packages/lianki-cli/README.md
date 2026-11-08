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

Make a token at [lianki.com/preferences](https://lianki.com/preferences)
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
| 5    | the server refused it (invalid value, rate limit) | `refused`                                                      |

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
