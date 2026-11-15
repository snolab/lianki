# Lane listeners: codex and agy hear the owner directly

Owner request, 2026-11-09 01:06 JST: the agy and codex lanes receive his
messages themselves, with no other lane passing them on, and only the lane he
addresses answers.

## The routing rule (one matcher)

`lib/lane-route.ts` decides, for each owner line in the owner thread, which
lane answers it. Every listener uses it, so a line gets exactly one answer
(or one per lane he names), never three:

| he says                                 | who answers         |
| --------------------------------------- | ------------------- |
| `codex, …` · `Codex：…` · `@codex …`    | codex alone         |
| `agy, …` · `A G Y …` · `antigravity, …` | agy alone           |
| `xiaoke, …` · `小可，…` · `Xiao Ke, …`  | the chat lane       |
| `codex 和 agy，…` · `codex and agy: …`  | codex and agy       |
| anything without a name in front        | the chat lane alone |

- The name comes first, after an optional wake word or greeting (`Linky,`,
  `hey`, `嘿`, `@`). `codex 线` / `codex lane` count as the name.
- A lane's own name (`codex`, `agy`, `antigravity`, `xiaoke`, `小可`) may be
  followed by a comma, colon, full stop, a space or Chinese text. How STT
  tends to write it (`Codecs`, `Code X`, `扣德克斯`, `反重力`, `Gemini`, `小克`,
  `晓可` … the `heard` lists in `LANE_NAMES`) needs a punctuation mark after
  it, so a sentence that merely starts with the word ("Codecs are hard…",
  "Gemini says…", "反重力的设计…") is not an address.
- `codex的…` is talk about codex, not to it: the chat lane takes it.
- Agent lines, friend lines and other threads are never routed.
- New spellings go in `LANE_NAMES` with a test in `unit/lane-route.test.ts`.
- The mapping can also be reconfigured live without deploys at `/dev/config`
  via `chat.lanes` (one table for lanes and their wake names; the earlier
  `chat.laneNames` key is folded into it: a row's `aliases` are its wake
  names, `heard` its STT spellings). `setCustomLaneNames(table)` takes the
  old name → {exact, heard} shape and writes it into the same table.
- Project and branch names (`lianki`, `liagent`, `agent-yes`, `otoji`) default
  to routing under the `chat` lane.
- All unique names in the table can be extracted via `laneHotwords(table?)`
  and fed to STT models (e.g. Whisper `initial_prompt`) to improve recognition.
- The matcher itself lives in `packages/debug-chat/src/lane-route.ts`
  (`lib/lane-route.ts` re-exports it), so the chat uses the same rule: a name
  heard in his live speech, or in a line he sends, flashes that lane's avatar
  once per utterance, and the sent line keeps a small mark of each lane it
  called (`addressed.ts`; the chat lane's route `chat` is 小克's avatar).

## Who listens how

| lane  | listener                                                                | posts with                |
| ----- | ----------------------------------------------------------------------- | ------------------------- |
| chat  | `eval.ts chat --route chat …` (the saved grant, as before)              | `eval.ts say` (the grant) |
| codex | `lianki-dev lane-listen --as codex --cwd ~/ws/snolab/lianki/tree/codex` | its own lane token        |
| agy   | `lianki-dev lane-listen --as agy --cwd ~/ws/snolab/lianki/tree/agy`     | its own lane token        |

`--route chat` drops the owner lines that route elsewhere (not printed, not
acked, their edits neither); everything else the chat listener printed is
unchanged.

`lane-listen` (`scripts/dev/lane-listen.ts`) runs `lianki-dev listen --as
<lane>` with the lane's token (`lianki chat listen`), keeps the lines the
matcher gives this lane, and hands each one to the lane's agent with
`ay send . --force` from the lane's directory (so it finds the agent however
often it restarted; `--deliver <pid>` names one instead). The hand-off holds
his words, the JST time, and the one command to answer with:

```bash
bun <repo>/scripts/dev/lianki-dev.ts say --repo <repo> --as codex "<reply>"
```

That posts with the lane's token: an agent line `【codex】…` with codex's
name, mark and voice (docs/lianki-dev-cli.md, "`lianki chat`"). The lane never
sees the token.

It reconnects with backoff when the socket drops, and stops (exit 2) when the
token is refused: revoked or expired. `--dry-run` prints the hand-offs instead
of sending them.

## The lane token

Each listening lane needs its own token, made by the owner (agents never make
or fetch one): lianki.com/preferences → API tokens → name = the lane (`codex`,
`agy`), permissions `chat:read` `chat:write` `chat:ask` and nothing else, an
expiry. It is kept on the Mac at `~/.config/lianki/lanes/<lane>.token`, mode
0600, or passed as `LIANKI_TOKEN`; `lianki-dev` reads the file for `say`,
`ask`, `listen` and `lane-listen` with `--as <lane>` and never prints it.
`lianki-dev doctor --as <lane>` says whether it is there. Without it,
`lane-listen` exits 2 naming the token it needs, and `say --as <lane>` keeps
using the saved grant (still labelled 【lane】).

With a token present, `say` takes no `--to` (the token path has none): the
line goes to the owner's thread in the lane's own voice, or in the one
`--voice` names (`main` is the chat lane's cat-girl voice; the same ids as
the grant path, checked by the hub).

## Running them

Both run under oxmgr, like the other long-running pieces:

```bash
oxmgr start "bun ~/ws/snolab/lianki/tree/main/scripts/dev/lianki-dev.ts lane-listen --as codex --cwd ~/ws/snolab/lianki/tree/codex" --name lianki-lane-listen-codex --max-restarts 3
oxmgr start "bun ~/ws/snolab/lianki/tree/main/scripts/dev/lianki-dev.ts lane-listen --as agy --cwd ~/ws/snolab/lianki/tree/agy" --name lianki-lane-listen-agy --max-restarts 3
```

and the chat lane's listener gets `--route chat` at the same moment, never
before: until codex and agy listen, a line addressed to them would reach no
one.

## Public CLI composition

The public CLI now has an unreleased composition layer for new installations:
`lianki chat listen --deliver . --cwd /path/to/agent`, also exposed as
`lianki chat bridge`. Existing `say` remains; `send` is its alias, and
`lianki chat read --limit 30 --json` reads finite history. Plain `listen`
remains a JSON/event stream. For optional Cloudflare AI filtering, stdin
adapters, update/dedup semantics and deployment boundaries, see
[the CLI workflow](../packages/lianki-cli/README.md#agent-chat-workflow-unreleased).
This does not replace or restart any current lane listener automatically.

## Stall watch: a lane stuck on a prompt

Peer feedback adopted 2026-11-11: the most common silent stall is a lane
sitting on a permission or confirmation prompt (Claude Code's "Do you want
to proceed?", a Codex approval, `[sudo] password for`, a passphrase or
Keychain prompt, `[y/N]`). Its own reports cannot say so, so a watcher on the
Mac does: `scripts/dev/stall-watch.ts` (pure parts in
`scripts/dev/stall-watch-lib.ts`).

- **What it reads.** One `ay ls --watch --local --cwd ~/ws/snolab/lianki`
  stream: ay's own diff of its agent registry, state edges
  (`active | idle | needs_input | stuck | stopped`) as NDJSON, no network.
  This is the only signal there is for a terminal agent, and one stream for
  every lane is the lightest form of it; the watcher itself has no timer
  that runs on a schedule. Only on an edge (the agent stopped printing, or
  ay saw a prompt) does it read that agent's tail (`ay tail -n 40 <pid>`,
  what ay already exposes), and once more when that edge's own timer fires.
- **What counts.** A known prompt in the bottom lines (the patterns in
  `PROMPT_PATTERNS`) still on screen after `stallWatch.promptGraceSec` (90 s;
  ay's own `needs_input` question counts too), or a screen whose last lines
  end in "?" / "？" unchanged for `stallWatch.quietMin` (10 min). Idle TUI
  chrome (the input box, footers, spinners) is ignored; a spinner with "esc
  to interrupt" means working.
- **What it writes.** One blocked node per agent in the progress hub,
  `/infra/agent-stall-watch/<lane>-<pid>`,
  `--status blocked --who main --needs "<lane> waits on a prompt: <line>"`
  (`--who owner` when the coordinator itself is stuck). The hub nudges main
  with its usual backoff (docs/state-tree.md, "Blocked and paused"). The
  watcher writes again only for a different prompt, at most once per agent
  per `stallWatch.reportGapSec` (5 min).
- **Cleared** when the screen moves on: ay says active, and a re-read after
  `stallWatch.clearConfirmSec` (20 s) no longer shows that prompt (a redraw
  of the same prompt does not clear it); or the agent exits. The node is
  closed `--done --verified "screen moved on …"`. At start it closes nodes an
  earlier run left open; a lane still stuck is reported again.
- **Never** answers a prompt, sends keys or messages to an agent, or touches
  a session beyond the tails ay shows. Every quoted line goes through
  `redact()` first (API keys, `lk_`/`sk-`/`ghp_`/`xox*` tokens, JWTs, Bearer
  values, `token=`/`password:` values, e-mail addresses, long hex/base64) and
  is cut to the hub's 120 characters.
- **Thresholds** are the `stallWatch.*` keys in `STALL_WATCH_CONFIG`; the
  watcher runs on the Mac, not the Worker, so each one's live value is its
  env var (`LIANKI_STALL_QUIET_MIN=15`, …) or a flag (`--quiet-min`,
  `--grace-sec`, `--interval`).

```bash
bun scripts/dev/stall-watch.ts --dry-run    # log what it would report, write nothing
oxmgr start "bun ~/ws/snolab/lianki/tree/main/scripts/dev/stall-watch.ts" --name lianki-stall-watch --max-restarts 3
```

Its log is one JSON line per state edge, read, report and clear (redacted).
Tests: `unit/stall-watch.test.ts` (the matcher on real Claude/Codex screens,
redaction, the node, the state machine).

## Every agent joins (全员入群, owner 2026-11-15)

Every agent working on Lianki or a repo it depends on joins his Li chat as a
lane of its own, automatically. One API token = one name = one lane: the hub
labels a token's lines with the token's name.

**Two identities.** A **listener** is resident: it hears every line live
(its socket is open) and shows in the presence stack (头像叠) as "listening
live". A **reader** reads the thread when it wants and is woken when he
names it. A joining agent is a reader by default; coco and 杰咪 listen to
everything (`lanes.agents` resident); Li, the main lane, is always a
listener and can never be downgraded (the hub refuses).

**The hub's lane registry** (`workers/push/src/lane-registry.ts`, flag
`chat.lane-events`, default on, audience owner). Per thread and lane: mode
(`reader` | `listener` | `left`), `muted`, last seen.

| what happens                                                                                 | mode     | system line (quiet)     |
| -------------------------------------------------------------------------------------------- | -------- | ----------------------- |
| first verified use (read, say, ask; an MCP wait; auth `mode: "reader"`)                      | reader   | "X 入群（只读）"        |
| a token socket that listens (`lianki chat listen`, auth `mode: "listener"` or none, not MCP) | listener | "coco 开始实时监听"     |
| its last listening socket closes and stays closed `lanes.modeGraceSec` (30 s; the alarm)     | reader   | "小开 转为只读"         |
| op `lane` `state: "left"` (the manager: its agent exited)                                    | left     | "杰咪 下线"             |
| the owner mutes it (page `participant` `muted: true`)                                        | (same)   | "X 已禁言" / "解除禁言" |

A reconnect inside the grace says nothing. The hub reads "listening" from
its attached sockets and their attachments, so a hibernated hub that wakes
still sees them. A connection that dies without its close reaching the
listener (the hub saw it close) is the listener's to find: `lianki chat
listen` sends `"ping"` every 10 s (`LIANKI_CHAT_PING_MS`; the hub's
auto-response answers `"pong"` without waking it), and a tick with no answer
ends it with exit 4. lane-listen then reconnects after 1 s when the socket
had lived a minute or more, inside the grace, and the new socket says
`mode: "listener"` again (2026-11-15: coco's half-open socket turned it
reader for the night). An HTTP `op:"lane"` `reader` while a socket of the
lane still listens leaves it a listener, as on a socket. A muted lane still reads and
listens; its `say`/`ask` get **403 `muted`** with the reason. The lines are
`from: "agent"`, label `lanes`, `quiet`, with `laneEvent` set; their text is
in `lanes.eventLocale` (zh), and a page shows them in its own language
(`packages/debug-chat/src/lane-events.ts`, 16 locales with context lines).
The presence list carries each token's `mode` and `muted`. The socket also
takes `{type:"lane", state: "listener"|"reader"|"left"}`, HTTP `{op:"lane",
state: "reader"|"left"}` (checked as a read, so the deployed main Worker
answers it). With the flag off, or before the hub is deployed, nothing of
this runs and the lanes work as before (the CLI's `mode` is ignored).

**The lane table** is config `chat.lanes` (public): `{id, name, aliases,
heard, voice, color}` rows beside the built-in coco / 杰咪 / 小克
(`voices.ts` setLaneTable, `lane-route.ts` laneNames). A row with a
built-in id adds names to it (咪宝 without a deploy). Routing, the avatar
flash, the wake words and the @mention read the same table. Scripts take
it as `LIANKI_LANE_TABLE` (lane-listen) or `LIANKI_CHAT_LANES` (the manager).

**The manager**, `lianki-dev lanes` (`scripts/dev/lanes-manager.ts`; pure
decisions in `lanes-manager-lib.ts`, the loop in `lanes-manager-core.ts`):

1. Watches `ay ls --watch --local` (ay's own registry diff); each edge
   re-reads `ay ls --json --local`, plus a slow re-list every
   `lanes.relistSec` (60 s) in case the stream is silent.
2. Maps each alive agent to a repo: the first part of its cwd on the
   `lanes.repos` whitelist (lianki, agent-yes, liagent, rechrome, otoji, rgui, mimiai).
3. Names it: the lane a running `lane-listen --deliver <pid>` already serves
   (coco, 杰咪 today), else `lanes.agents` (the end of its cwd + its cli),
   else `<repo>-<leaf>`, stable across restarts so one token keeps serving
   it: the leaf is `<x>` for `…/<repo>/tree/<x>`, `agent` for a Claude
   worktree (`.claude/worktrees/agent-<id>`), `main` for a bare checkout,
   else the directory's name (`lianki-codex`, `lianki-agent`,
   `liagent-main`); lowercase, 40 characters at most. Only when two alive
   agents would share it does `-<cli>` follow, then `-<pid>` if they still do.
4. Tokens: `~/.config/lianki/lanes/<lane>.token`, minted by him at
   /my/preferences#tokens (name = the lane, chat:read chat:write chat:ask).
   The manager never mints one; the names still missing are said once in
   the chat as one line, with its own token (`lanes.token`, name `lanes`,
   `LIANKI_LANES_MANAGER_LANE`), again only when the list changes.
5. Resident lanes get `lane-listen --as <lane> --cwd <cwd> --all` (not when
   one already runs, e.g. under oxmgr); stopped when the agent exits.
   Readers get no process: the manager's own reader socket (`lianki chat
listen --json --reader`) hears his lines, and a line that names a reader
   (its lane name, a `chat.lanes` alias, `#<repo>`, or 全体) goes to that
   agent with `ay send <pid> --force --no-wait --code alt-m`.
   A `lanes.agents` row with `wake: false` joins (greets, reader, marked
   left) but is never woken: 小克 (`lianki/tree/agy`, cli `claude`, lane
   `claude`) keeps its own live feed of his lines.
6. Each new lane greets once with its own token (`lanes.greeting`;
   `manager-state.json` beside the tokens remembers who did); an agent that
   exits is marked left (op `lane`).
7. Joined agents report as every lane does: `lianki-dev say/reply --as
<lane>` in the chat, `progress.ts` on the state tree.

The Mac-side keys (`lanes.repos`, `lanes.agents`, `lanes.relistSec`,
`lanes.greeting`) are in the config registry with their defaults
(`lib/lanes-config.ts`); on the Mac each live value is its env var
(`LIANKI_LANES_REPOS`, `LIANKI_LANES_AGENTS`, `LIANKI_LANES_RELIST_SEC`,
`LIANKI_LANES_GREETING`), as for stall-watch.

```bash
bun scripts/dev/lianki-dev.ts lanes --once --dry-run   # who would join, what it would do
oxmgr start "bun ~/ws/snolab/lianki/tree/main/scripts/dev/lianki-dev.ts lanes" --name lianki-lanes --max-restarts 3
```

Tests: `unit/lanes-manager.test.ts` (mapping, decisions, the loop mocked),
`unit/lane-registry.test.ts` (transitions, system lines, mute, through the
hub), `unit/lane-table.test.ts` (dynamic lanes and routing),
`unit/lane-events.test.ts` (strings).

## End-to-end test

Agent lines are never routed, so the test posts a marked line that only a
listener started with `--tests` takes:

```bash
lianki-dev say "[lane-test] codex, 路由测试，请回一句"   # main's grant, shows as a test
lianki-dev say "[lane-test] agy, 路由测试，请回一句"
```

Pass: codex answers `【codex】[lane-test] …` once, agy likewise, and neither
answers the other's line; the chat lane ignores both (it ignores agent lines).
Then restart the listeners without `--tests`.

Tests: `unit/lane-route.test.ts` (the matcher), `unit/lane-listen.test.ts`
(token lookup, line parsing, the hand-off).

- **Urgent lines break in (2026-11-14 23:0x).** A line that names the lane, or starts with 全体 (every lane at once, `lane-route.ts`), or an ETA nudge addressed to it, is handed over immediately with `ay send --code alt-m` (interrupting the turn) together with whatever was waiting; everything else still waits for the batch (`urgentLine` in `scripts/dev/lane-listen-lib.ts`).
