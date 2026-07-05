# lianki

Command-line client for [Lianki](https://lianki.com) — an FSRS spaced-repetition
app. Built for **agents and scripts**: non-interactive auth, and every data
command prints the server's JSON verbatim to stdout.

```bash
npx lianki help
```

## Auth

Mint an API token in the Lianki web UI (**Settings → API Tokens**); it looks like
`lk_…`. Provide it any of these ways (checked in order):

1. `--token lk_…` flag (per call)
2. `LIANKI_TOKEN` environment variable
3. saved config: `lianki login lk_…` → `~/.config/lianki/config.json`

```bash
export LIANKI_TOKEN=lk_xxx          # agents: set once in the environment
# or
npx lianki login lk_xxx             # humans: persist to ~/.config/lianki
echo "$TOKEN" | npx lianki login    # or pipe via stdin
npx lianki whoami                   # verify
```

## Commands

| Command | Description |
| --- | --- |
| `add <url> [--title T]` | Add a card |
| `due [--limit N]` | List due cards (`--exclude-domains a,b`) |
| `next` | Next due card's url (`--exclude-url U`, `--exclude-domains a,b`) |
| `get <url>` | Fetch one card by url |
| `review <url> <again\|hard\|good\|easy>` | Grade a card |
| `delete <url>` | Delete a card |
| `move <oldUrl> <newUrl>` | Change a card's url |
| `export [--out FILE]` | Export everything as YAML |
| `import <file.yaml>` | Restore from a YAML export |
| `login` / `logout` / `whoami` | Manage / verify the saved token |

Ratings accept `again hard good easy` or `1 2 3 4`.

## Output contract

- **Success:** JSON to **stdout**, exit `0`. (`export` prints raw YAML.)
- **Failure:** `{"error":…}` (plus `status` for HTTP errors) to **stderr**;
  exit `2` for auth errors (401/403), `1` otherwise.

This makes it safe to pipe into `jq`/`node -pe` and to branch on exit code:

```bash
url=$(npx lianki next | jq -r .url)
[ "$url" != "null" ] && npx lianki review "$url" good
```

## Targeting a different backend

Point at any Lianki-compatible API (e.g. a preview/staging worker) with
`--api` or `$LIANKI_API`:

```bash
LIANKI_API=https://lianki-cf.snomiao.workers.dev npx lianki due
```

Defaults to `https://www.lianki.com`.

## Requirements

Node ≥ 18 (uses the built-in global `fetch`). Only runtime dependency: `yargs`.
