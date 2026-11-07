# `lianki-dev`: the agent lanes' CLI

One entry, `scripts/dev/lianki-dev.ts`, for every lane (main, chat-fast,
codex, agy, judge…). Each subcommand runs the script that already does the
job, so it adds no powers: the same saved grant, the same scopes.

Not to be confused with the npm **`lianki`** CLI (`packages/lianki-cli`):
that one is the users' (cards, settings, against the public API).
`lianki-dev` is the owner's dev tooling and takes that CLI's exit codes and
JSON envelope, so an agent reads both the same way.

| command    | runs                                    | needs                        |
| ---------- | --------------------------------------- | ---------------------------- |
| `say`      | `eval.ts say`                           | saved grant, network         |
| `voices`   | `eval.ts voices` (`--cloud`: no page)   | saved eval grant, network    |
| `ask`      | `eval.ts ask`                           | saved grant, network         |
| `inbox`    | `eval.ts inbox list\|get\|done`         | saved grant, network         |
| `listen`   | `eval.ts chat` (one JSON line an event) | saved grant, network         |
| `serve`    | `eval.ts serve`                         | saved eval grant, network    |
| `progress` | progress.ts's modules (with `--eta`)    | progress token, network      |
| `whoami`   | lane, checkout, hub, grant/token found  | nothing                      |
| `doctor`   | one line per missing piece              | nothing (checks the network) |

```bash
lianki-dev say --as codex "PR #670 is green"        # → 【codex】PR #670 is green
lianki-dev say --voice device:Meijia "你好呀"         # one line in a phone voice (ids: lianki-dev voices)
lianki-dev voices                                   # the phone's device voices + the cloud's, as ids
lianki-dev ask --as judge --q "Ship it?" --opt Yes --opt No --wait
lianki-dev progress --as codex --path /dev/cli --task "CLI" --status doing --pct 40 --eta 30m
lianki-dev doctor --as codex                        # what is missing here
lianki-dev <command> --help
```

## Lanes

- `--as <lane>` or `LIANKI_LANE=<lane>` labels each `say` line and each
  `ask` question `【<lane>】` (until multi-lane chat ships), and is the
  default `--agent` of a `progress` report.
- **Lanes never pair.** `--no-pair` is always passed to eval.ts; `--pair` is
  for a human at the terminal, and a usage error with a lane set. With no
  saved grant a command exits 2 before opening a socket.
- Never `--quiet` by default; pass it yourself for an FYI line.

## What it needs (and what it doesn't)

`say`, `ask` and `inbox` need only **the saved grant and the hub URL**: no
`.env.local`, no `.dev.vars`. The grant files are at the **main checkout's
root** (`.debug-chat-token.json`, else `.debug-eval-token.json`), found
through `git --git-common-dir`, so every worktree shares them
(`LIANKI_CHAT_TOKEN_FILE` / `LIANKI_EVAL_TOKEN_FILE` override).
`~/.config/lianki` holds only `serve`'s session file. The hub is
`LIANKI_URL`, default `https://lianki.com`. `progress` also needs a token:
`--token`, `LIANKI_PROGRESS_TOKEN`, or `PROGRESS_TOKEN` in the main
checkout's `.dev.vars`.

Which checkout's scripts run: `--repo <path>` (or `LIANKI_REPO`), else the
git worktree of the current directory, else the CLI's own checkout. So it
works from any worktree, and from outside one with `--repo`.

## A read-only sandboxed lane (codex)

`doctor` shows `missing network` (exit 4). A lane with no network cannot
post, ask, listen or report, whatever the CLI does. The options, none of
which the CLI takes for you:

1. **The lane asks main to post for it**: it hands its line to main, and
   main runs `lianki-dev say --as codex "…"`.
2. **The owner relaxes that lane's sandbox** to allow network. Writes are
   not needed for `say`/`ask`/`inbox`.
3. **A local relay**: a process outside the sandbox that posts what the lane
   hands it. Not built.

## Exit codes and JSON

| exit | meaning                                              | `error.code` |
| ---- | ---------------------------------------------------- | ------------ |
| 0    | ok                                                   |              |
| 1    | usage; nothing sent                                  | `usage`      |
| 2    | not ready here: no grant, token or checkout          | `not_ready`  |
| 4    | the hub could not be reached                         | `network`    |
| 5    | the hub refused it (invalid grant, out of scope, …)  | `refused`    |

Without `--json`, `say`/`ask`/`inbox` print eval.ts's JSON line as is. With
`--json`, a success is one line `{"v":1,"ok":true,"command","data"}` on
stdout, and a failure one line `{"v":1,"ok":false,"error":{code,message},"exit"}`
on stderr, with nothing on stdout. `listen` streams eval.ts's lines either
way.

## Install

The repo's `package.json` has `"bin": {"lianki-dev": "scripts/dev/lianki-dev.ts"}`.
From the main checkout, either:

```bash
bun link        # puts `lianki-dev` in ~/.bun/bin, pointing at this checkout
# or a one-line shim on your PATH:
printf '#!/bin/sh\nexec bun ~/ws/snolab/lianki/tree/main/scripts/dev/lianki-dev.ts "$@"\n' > ~/.local/bin/lianki-dev && chmod +x ~/.local/bin/lianki-dev
```

Either way, run from inside a worktree it uses that worktree's scripts.
Without installing: `bun scripts/dev/lianki-dev.ts …`.

Tests: `unit/lianki-dev-cli.test.ts` (parsing, labels, doctor, exit codes,
and `say` against a stub hub on 127.0.0.1).
