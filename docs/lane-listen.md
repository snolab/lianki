# Lane listeners: codex and agy hear the owner directly

Owner request, 2026-11-09 01:06 JST: the agy and codex lanes receive his
messages themselves, with no other lane passing them on, and only the lane he
addresses answers.

## The routing rule (one matcher)

`lib/lane-route.ts` decides, for each owner line in the owner thread, which
lane answers it. Every listener uses it, so a line gets exactly one answer
(or one per lane he names), never three:

| he says                                    | who answers           |
| ------------------------------------------ | --------------------- |
| `codex, …` · `Codex：…` · `@codex …`       | codex alone           |
| `agy, …` · `A G Y …` · `antigravity, …`    | agy alone             |
| `xiaoke, …` · `小可，…` · `Xiao Ke, …`     | the chat lane         |
| `codex 和 agy，…` · `codex and agy: …`     | codex and agy         |
| anything without a name in front           | the chat lane alone   |

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

## Who listens how

| lane  | listener                                                                 | posts with                    |
| ----- | ------------------------------------------------------------------------ | ----------------------------- |
| chat  | `eval.ts chat --route chat …` (the saved grant, as before)               | `eval.ts say` (the grant)     |
| codex | `lianki-dev lane-listen --as codex --cwd ~/ws/snolab/lianki/tree/codex`  | its own lane token            |
| agy   | `lianki-dev lane-listen --as agy --cwd ~/ws/snolab/lianki/tree/agy`      | its own lane token            |

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

With a token present, `say` takes no `--to`/`--voice` (the token path has
none): the line goes to the owner's thread in the lane's own voice.

## Running them

Both run under oxmgr, like the other long-running pieces:

```bash
oxmgr start "bun ~/ws/snolab/lianki/tree/main/scripts/dev/lianki-dev.ts lane-listen --as codex --cwd ~/ws/snolab/lianki/tree/codex" --name lianki-lane-listen-codex --max-restarts 3
oxmgr start "bun ~/ws/snolab/lianki/tree/main/scripts/dev/lianki-dev.ts lane-listen --as agy --cwd ~/ws/snolab/lianki/tree/agy" --name lianki-lane-listen-agy --max-restarts 3
```

and the chat lane's listener gets `--route chat` at the same moment, never
before: until codex and agy listen, a line addressed to them would reach no
one.

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
