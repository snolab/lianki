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
| `withdraw` | `eval.ts withdraw <askId>\|--last`: an obsolete ask card greys out, untappable, never read aloud | saved grant, network |
| `inbox`    | `eval.ts inbox list\|get\|done`         | saved grant, network         |
| `listen`   | `eval.ts chat` (one JSON line an event) | saved grant, network         |
| `lane-listen` | `lane-listen.ts`: the owner lines addressed to this lane, to its agent ([lane-listen.md](lane-listen.md)) | the lane's token, network |
| `serve`    | `eval.ts serve`                         | saved eval grant, network    |
| `progress` | progress.ts's modules (with `--eta`)    | progress token, network      |
| `whoami`   | lane, checkout, hub, grant/token found  | nothing                      |
| `doctor`   | one line per missing piece              | nothing (checks the network) |

```bash
lianki-dev say --as codex "PR #670 is green"        # → 【codex】PR #670 is green
lianki-dev say --voice device:Meijia "你好呀"         # one line in a phone voice (ids: lianki-dev voices)
lianki-dev voices                                   # the phone's device voices + the cloud's, as ids
lianki-dev ask --as judge --node /dev/cli --q "Ship it?" --opt Yes --opt No --wait
lianki-dev progress --as codex --path /dev/cli --task "CLI: one entry for the lanes" --status doing --pct 40 --eta 30m
lianki-dev progress stats --as codex --since 7d    # your done tasks: estimate vs actual, median ratio
lianki-dev doctor --as codex                        # what is missing here
lianki-dev <command> --help
```

## Lanes

- `--as <lane>` or `LIANKI_LANE=<lane>` labels each `say` line and each
  `ask` question `【<lane>】` (until multi-lane chat ships), and is the
  default `--agent` of a `progress` report (and of `progress stats`).
- A `progress --task` is "name: description" (':' or '：'): a name of 1–20
  characters, then what it is — the owner's ETA bar shows only the name, the
  list both. A longer name is a usage error; no colon and over 20 is a
  warning. [docs/state-tree.md](state-tree.md), "Live progress".
- **ETA overrun (standing rule).** A task past its `--eta` and not done
  must, within 5 minutes, tell the owner why and a new time:
  `lianki-dev progress --as <lane> --path <node> --task "<same>" --status doing --eta 20m --late "<reason>"`.
  The hub posts "<name> 超时：<reason>。再要 20 分钟" in his Li thread; past the
  ETA a new `--eta` without `--late` is refused; with nothing for 5 minutes he
  hears "<name> 超时，未说明原因". [docs/state-tree.md](state-tree.md), "ETA overrun".
- With `LIANKI_TOKEN` set (a lane token, below), `say`, `ask` and `listen`
  run `lianki chat …` instead of eval.ts: the label is the token's name, not
  `--as`, and `--to`, `--task-path`, `--agent`, more than one `--q` and
  listen's flags are usage errors (they need the grant path). `inbox`,
  `serve` and `progress` are unchanged. With `--as <lane>` and no
  `LIANKI_TOKEN`, the lane's file `~/.config/lianki/lanes/<lane>.token`
  (0600) stands for it; never printed ([lane-listen.md](lane-listen.md)).
- **Asks on a node** ([planning-tools.md](planning-tools.md), step 7). An
  `ask` from a lane names the state tree node it is about: `--node /path`,
  else `LIANKI_TASK_PATH`; without one it is a usage error (exit 2), and the
  node must already be in the tree (report it first). The question is
  written on the node as a note `ask: …` before the card goes out; with
  `--wait` the tap is written too, `answer: <question> → <option>`, so the
  decision lives on the node, not only in the chat (scripts/dev/ask-node.ts).
  Without `--wait` the lane notes the answer itself when it hears it
  (`progress … --note "answer: …"`). A human at the terminal (no `--as`) may
  leave `--node` out. Works on both paths (grant and lane token); the notes
  are written with the progress token.
- **Slack asks** (longer decisions, from the main lane's bot outbox) carry
  the node path in their first line (`Tree: /path`). When the owner answers
  in Slack, the main lane writes the answer back on that node:
  `progress.ts --agent main --path /path --task "<same>" --status <same> --note "answer (Slack): …"`,
  or `progress.ts resolve --id /@owner/<slug> --note "…"` when the ask was an
  owner to-do. A Slack decision with no node line is still answered, but the
  main lane first puts it on a node.
- **Lanes never pair.** `--no-pair` is always passed to eval.ts; `--pair` is
  for a human at the terminal, and a usage error with a lane set. With no
  saved grant a command exits 2 before opening a socket.
- Never `--quiet` by default; pass it yourself for an FYI line.

## `lianki chat`: a lane's own token (owner decision 2026-11-07)

The public CLI (`packages/lianki-cli`, npm `lianki`) has `lianki chat
say | ask | read | listen`, signed in with an API token (`lianki auth login`, or
`LIANKI_TOKEN`). It reaches **only the token account's own chat thread**: a
user's Learning Partner thread, or, for the owner's account, the owner's
thread. Post a line, post an ask card, read and follow lines. Nothing else:
no eval, no pairing, no grants, no inbox, no clips, no other thread, no admin.
The owner's eval, pairing and code execution stay in `eval.ts` / `lianki-dev
serve` (the grant path), never in the public CLI.

**A lane gets its token** from the owner: lianki.com/preferences → API tokens
→ name = the lane (`codex`, `agy`, `main`…), permissions `chat:read`,
`chat:write`, `chat:ask` (nothing else), an expiry (required; ≤ 1 year). The
secret is shown once; the owner hands it to that lane only, as `LIANKI_TOKEN`
(never in a URL, a log, a commit or a chat line). One click on Revoke kills it:
its next call is refused and a listening socket closes at once. Agents never
make tokens for the owner.

**A lane uses it**:

```bash
export LIANKI_TOKEN=lk_…                      # this lane's token, from the owner
lianki chat say "PR #670 is green"             # → 【codex】PR #670 is green (agent line)
lianki chat ask --q "Ship it?" --opt Yes --opt No --recommend 1 --wait   # prints the tapped option
lianki chat read --limit 20 --json
lianki chat listen --json                      # one JSON line an event
lianki-dev say "…" / ask … / listen            # the same path while LIANKI_TOKEN is set
```

What the server does (`workers/push/src/token-chat.ts`, `lib/chat-token.ts`):

- `POST /api/version/chat` (`op` say | ask | read, `Authorization: Bearer`),
  and a WebSocket at the same path whose **first message** carries the token.
  lianki-push asks the main Worker (`DebugSessions.chatToken`, a service-binding
  RPC with no URL) for every call: the permission for that op, unexpired, its
  account's live row, a per-token rate limit (say+ask 60, read 240, listen
  connects 30 per 10 min, in D1). Deny by default; the answer names the one
  thread. Nothing in a request can name a thread.
- A token's line is an **agent line** (`from: "agent"`, `via: "token"`,
  `tokenLane` = the token's name, text `【name】…`; a token named codex, agy or main also gets that lane's `lane`, mark and voice): it never speaks as the owner
  or the user.
- **Ask cards**: only a tap on a page of that thread answers one; a token (or
  controller) never can. The `answered` event goes to the thread's pages and
  to that account's sockets **of the same lane** only, not to other lanes or
  eval.ts listeners; another lane's `read` gets the card without its answer.
- A listening socket keeps the token's hash, not the secret. Closed on
  revoke (`/internal/chat-tokens/revoked` from the main Worker), on expiry
  (checked on every event for it), and when a re-check (every ≤ 5 min, before
  a delivery) is refused. At most 4 sockets per token.
- Lanes listening with a token count in the pages' "agent listening".
- Every use, refusal, creation and revocation is in `security_audit` by the
  token's tag ([secrets-and-auth.md](secrets-and-auth.md), "API tokens").

`listen` and `ask --wait` need a WebSocket: Node 22+ or Bun.

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
