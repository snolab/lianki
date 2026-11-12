# Shipping, CI, and post-deploy QA

## Landing a change

Commit on `main`, then:

```bash
bun scripts/ship.ts
```

It pushes HEAD to a `ship/<sha>` branch, opens a PR, arms auto-merge (squash),
waits for the required checks, then syncs local `main` and deletes the branch.
`main` is the only long-lived branch.

`main` cannot be pushed to directly: `enforce_admins` is on, so a direct
`git push origin main` is rejected with `GH006 … 2 of 2 required status checks
are expected` unless the pushed SHA already has green checks. The PR is what gets
the checks run.

`scripts/ship.ts` uses `git reset --keep`, not `--hard`, so a sync can never
silently eat uncommitted work.

### The PR on its node

Every PR belongs to a state tree node (docs/planning-tools.md). Once the PR
is open, ship.ts reports `--pr N` on that node itself, keeping its title and
status (scripts/ship-node.ts). The node, first found wins:

1. `bun scripts/ship.ts --node /read/review-sheet`
2. `LIANKI_TASK_PATH=/read/review-sheet` (the lane's node, as `eval.ts` reads it)
3. a line `Tree: /read/review-sheet` of its own in the commit message

It writes as `LIANKI_AGENT` when set (a scoped token writes only as its own
agent), else as the node's creator, with the progress token (`progress.ts`
finds it the same way). No node named, no token, or a node not in the tree:
ship.ts warns and goes on — the PR still lands; report it by hand
(`progress.ts … --pr N`). A lane shipping from its own branch with `gh pr
create` reports `--pr` itself, as before. The node keeps every PR it named
(`prs`), and /dev/roadmap links them.

## CI

CI selects tests from the change graph (below, "Only what changed"),
with full unit coverage in the merge queue and on main.
`.github/workflows/ci.yml` has these jobs:

- `Lint + typecheck + unit` — oxlint + `oxfmt --check`, typecheck, affected unit
  tests on PRs, and the whole unit suite with coverage in every merge group
  and on every push to `main`; when it fails on a push to `main` it posts to Slack #lianki.
- `qa` — affected suites plus the smoke set, on `merge_group` (and every
  suite on a manual
  dispatch), as one build job and three parallel shards
  (`.github/workflows/qa-sharded.yml`, below). The selector falls back to the full
  integration gate for core changes, while opening a PR and main's deploy wait
  for neither. It blocks; `QA_BLOCKING: "false"` in ci.yml turns a failure
  into a warning instead (used while WORDS' Settings-sheet check failed in CI,
  2026-11-08).
- `Typecheck + unit` — the one required check (branch protection names it). A
  tiny job that is green when the first job passed and `qa` (its build and
  every shard) passed or was skipped (outside the merge queue). It is the
  aggregator the shards report through, so neither the qa job nor its shards
  needed a change to branch protection or the ruleset.

### qa:all in shards

Until 2026-11-10 the merge queue ran qa:all as one job: ~12.5 min (median 755 s:
container 31 s, setup 25 s, OpenNext build 40–50 s, local D1 migrations 20 s,
then 25 suites one after another, ~11 min). Now:

1. **`qa build`** (plain runner, Node 24): `qa-all.mjs --prepare` builds the
   OpenNext Worker and migrates a local D1, then ships `.open-next` and
   `.wrangler/state` to the shards as one tarball artifact (it keeps the
   build's internal symlinks). `.next/cache` (Turbopack's build cache, on by
   default since Next 16.3) is kept in the Actions cache. Only caches saved on
   `main` reach a merge-queue run (one saved on a `gh-readonly-queue` ref is
   visible to that ref only), so Full QA's runs on main are what keep it warm.
2. **`qa:all 1/3`, `2/3`, `3/3`** (Playwright image, `fail-fast: false`):
   `qa-all.mjs --no-build --shard=i/3` boots its own `wrangler dev` on the
   prepared build and runs its third of the suites. Time-sensitive suites
   still run after the plain ones in each shard, as before; CI needs no
   admission (each runner has its machine to itself).

**The split** (`scripts/qa/shard.mjs`, tested in `unit/qa-shard.test.ts`):
longest suite first onto the shard with the least time so far, by the median
seconds in `scripts/qa/suite-timings.json`; a suite not listed counts 30 s.
Each job computes the same split by itself. AUDIO-FREE (`everyShard: true`)
starts every shard, because the suites after it rely on its silent layer.
Every suite prints `qa:all timing <id> <seconds>`; re-record the medians from
the last green merge-queue runs with `bun scripts/qa/record-timings.ts` when a
shard runs long (a new suite, a slower one).

Locally, `--shard=i/n` and `--prepare` work the same, and a plain
`bun run qa:all` is unchanged. Full QA (below) uses the same workflow plus the
extension smoke test in shard 1.

### Unit tests on a PR

A PR runs `bun scripts/gate/affected.ts unit --parallel` with
`LIANKI_GATE_BASE=pull_request.base.sha`. The same graph as pre-push selects
its tests; each test file runs in an isolated worker. A `UNIT_FULL` path or
an unavailable graph runs the whole suite with coverage. Merge groups and
pushes to main always run the whole unit suite with coverage.

### Affected-only in the merge queue

Since 2026-11-10 the merge queue runs only the qa suites a merge group can
reach, plus a smoke set; the full set runs after merges on main (below). The
`qa plan` job in ci.yml runs `bun scripts/gate/affected.ts ci-qa` with
`LIANKI_GATE_BASE=merge_group.base_sha`: the files the group changes on top of
main (this PR and the ones queued ahead of it) go through the same graph and
`paths` as the pre-push gate (next section, "Only what changed"). It writes
`suites=<ids>` for the shards:

- the affected suites plus **`QA_SMOKE`** (`api`, `ui`, `sign-out`, in
  `affected-lib.ts`), always;
- `suites=` (empty), meaning **every suite**, when a `QA_FULL` path changed
  (the Worker's build and serving, migrations, qa:all's own machinery, the
  core) or the graph could not be built — the same fallback as pre-push;
- every suite on a manual dispatch.

`LIANKI_GATE_CHANGED="lib/x.ts" bun scripts/gate/affected.ts ci-qa` shows
what a group touching `lib/x.ts` would run. A shard left with no suite exits
at once.

### Full QA and the deploy hold

`.github/workflows/nightly-qa.yml`, now named **Full QA**, runs every suite
plus the extension smoke test on `main`. It is **never on a timer** (owner,
2026-11-10: he can be away for days, and with no merges nothing should run;
the 03:00 JST nightly cron is gone). It starts from merges, through
`.github/workflows/full-qa-trigger.yml` on every push to `main`
(`scripts/ci/full-qa.ts trigger`; the decision is `decideTrigger` in
`scripts/ci/full-qa-lib.ts`, tested in `unit/full-qa-hold.test.ts`):

- **Covered:** main counts as tested up to the newest full run that is green
  or still queued/running. Nothing untested: nothing runs.
- **At once** when a file since then matches a `QA_FULL` path (the core, the
  Worker's build and serving, migrations, qa:all's own machinery — the same
  list that sends pre-push and the merge queue to the full set), or when
  `FULL_QA_MAX_MERGES` (default 10) merges are untested.
- **Debounce:** otherwise the trigger job waits `FULL_QA_QUIET_MIN` (default 15) minutes and then starts the run. Its concurrency group cancels it when
  the next merge arrives, and that merge decides again, so the run starts
  once merges have been quiet that long.
- **Throttle:** while merges keep coming, the run starts at the latest when
  the oldest untested merge has waited `FULL_QA_MAX_WAIT_H` (default 4) hours.
- Also by hand (`gh workflow run nightly-qa.yml -R snolab/lianki`), and from
  the deploy hold below.

The three numbers are defaults in `FULL_QA_DEFAULTS`; a repo variable of the
same name (Settings → Secrets and variables → Actions → Variables) overrides
each without a code change. A running full run is never cancelled: a newer
start waits behind it.

When it goes red:

1. **#lianki** hears it (`SLACK_WEBHOOK_URL`), with the run link.
2. **A revert PR** (`scripts/ci/full-qa.ts revert`): every commit on `main`
   since the last green full run, reverted on `revert/full-qa-<sha>`, for a
   person to merge or close; nothing merges it by itself. It is opened with
   the workflow token, which needs the repo setting _Allow GitHub Actions to
   create and approve pull requests_ (off as of 2026-11-10). Without it the
   branch is still pushed and the alert carries the compare link instead. A
   PR opened by the workflow token gets no CI of its own: push to it, or close
   and reopen it, to start the checks. Commits that do not revert cleanly
   leave only a warning.
3. **Deploys are held.** `deploy-worker.yml` starts with the `Full QA hold`
   job (logic in `scripts/ci/full-qa-lib.ts`, tested in
   `unit/full-qa-hold.test.ts`): it reads the latest finished Full QA run on
   main (cancelled runs do not count) and, while that run is red, deploys
   nothing — the run fails with "Deploy held", so it shows — and starts a
   Full QA run if none is queued. **Lifting it:** a green Full QA run whose
   newest decided predecessor was red runs its `On green` job, which
   dispatches Deploy Worker with `lifted_by=<its run id>` and
   `sha=<the commit it tested>`; deploy-worker checks that the run is Full
   QA's, tested that commit and passed every `qa /` job (`liftIsGenuine`), and
   deploys that commit. A green run with no hold to lift deploys nothing (CI
   already did). It cannot be a `workflow_run` on Full QA: Full QA is started
   with the workflow token (by the trigger or by the hold), and a run started
   that way starts no `workflow_run` — the hold of 2026-11-10 (red at
   3eb0aeed, green again 23:32 UTC) lifted nothing that way.
   `workflow_dispatch` is the one event the token may start. **Override:** run Deploy Worker by hand with
   `override_hold` (`gh workflow run deploy-worker.yml -R snolab/lianki -f
override_hold=true`).

Concurrency: the free plan gives 20 concurrent jobs. A merge-queue entry now
takes 5 (checks, build, 3 shards) and the queue builds up to 5 entries, so a
full queue waits a little for runners rather than failing.

A CI runner is slower than a laptop, and the phone passes of qa-words run side
by side (#704): WebKit there can go a while without a rendering update, and a
`getComputedStyle` read then returns a stale frame — of an animation that has
already finished (WORDS' Settings sheet read `translate: 0 50%` with its
slide-in finished, 2026-11-08). A layout check measures with
`reducedMotion: "reduce"` and after a fresh frame, not after a fixed wait.

Two more from the merge queue of 2026-11-09 (state tree /infra/qa-words-flake):

- **A drag waits for its preview before letting go.** dnd-kit drops where the
  last _drawn_ frame put the row; on a busy runner React draws the move late,
  and a release straight after `mouse.move` dropped a nest that was never
  shown (#714). qa-words now waits for the indent (or the row making room)
  before `mouse.up`, and polls the saved order on a load budget, not 10 × 300 ms.
- **WebKit never leaves a `setContent` page that frames /words.** The goto
  after it hung at `"commit"` for 40–49 s, the same step in both failures
  (#709, #727) with the Worker idle meanwhile; no other WebKit load did. The
  framed check now runs in a page of its own, closed after.

main's deploy waits for this workflow on the push to `main` (no qa job there:
it ran in the queue).

The integration gate (qa:all in shards plus the extension smoke test) also
runs on main **after merges, never on a timer** (below, "Full QA and the deploy
hold") and
posts to #lianki when it fails. It left the per-push CI
on 2026-10-31 so a deploy no longer waits for it. Node 24 (for `node:sqlite`);
wrangler runs D1 locally, so no Cloudflare secrets are needed. Both alerts need
the repo secret `SLACK_WEBHOOK_URL` (`scripts/ci/slack-alert.sh`); without it
they only leave a workflow warning.

### Flaky tool downloads

On 2026-11-09 GitHub's release CDN answered 504 for long stretches: setup-bun
("Unexpected HTTP response: 504") and the gitleaks `curl` died, PRs fell out
of the merge queue and a deploy was skipped. Since then (/infra/ci-retry):

- **Bun** comes from `.github/actions/setup-bun` (a local composite action;
  every workflow uses it). The version is pinned there (`bun-version`, now
  1.4.4 — bump it there, nowhere else) and `~/.bun/bin` is cached under
  `bun-<version>-<os>-<arch>`, so most jobs download nothing. On a miss it runs
  `oven-sh/setup-bun` with `continue-on-error`; if that fails it fetches the
  same binary from npm (`@oven/bun-linux-x64`, another CDN), then the GitHub
  release zip. The log line `bun 1.4.4 (cache hit: true)` says which path ran.
- **gitleaks** (ci.yml, version in the job's `GITLEAKS_VERSION`) is cached
  under `gitleaks-<version>-<os>-<arch>`; a miss downloads it.
- Every download goes through `scripts/ci/fetch.sh`: to a file, 3 attempts,
  10 s then 30 s apart. A retry leaves a `download retry` warning on the run.

A new tool a workflow downloads gets the same: a pinned version, an
`actions/cache` keyed by tool + version + OS + arch, and `fetch.sh`.

## Local hooks

Split by speed since 2026-11-04 (a commit used to run typecheck and the whole
unit suite, 30 s to several minutes):

- **`pre-commit`** — seconds, staged files only: secretlint, oxlint `--fix` +
  oxfmt on staged JS/TS (`.lintstagedrc.mjs`), and the generated copies only
  when their inputs are staged — userscript build, `@version` check,
  `lianki.meta.js` / `lib/userscript-version.ts` sync, the state-tree and blog
  bundles (`scripts/pre-commit.ts`, plan in `scripts/pre-commit-plan.ts`).
- **`pre-push`** — cheapest first, so a failure surfaces in seconds:
  `bun run lint` (whole repo), typecheck, then **only the unit tests and
  qa:all suites the change reaches** (next section). Only qa:all's
  time-sensitive suites wait for the machine-wide gate, below.

So a commit can be locally unchecked for types and tests until it is pushed;
nothing reaches `main` that way, because `main` takes only PRs and the required
CI check runs lint, typecheck and the unit suite with coverage on each one, and
the merge queue runs the full qa:all. The generated copies are each pinned by a
unit test (`unit/state-tree.test.ts`, `unit/blog-corpus.test.ts`,
`unit/userscript-version.test.ts`), so a missed regeneration fails pre-push and
CI.

A `--no-verify` skip pushes a commit nothing local has tested; CI still runs
everything before it lands. The hook skips automatically for deletion-only
pushes. On **native Windows** (Git Bash)
it skips qa only — lint, typecheck and the unit tests still run — because
the OpenNext Cloudflare packaging cannot produce a working Worker there (symlink
copy errors with bun's isolated linker, `ChunkLoadError` on every route with a
hoisted install; verified 2026-10-14). There CI's runs (merge queue, Full QA) are the only
integration gate; `LIANKI_QA_ON_WINDOWS=1` forces the local run, for example to
re-test after an OpenNext upgrade. WSL counts as Linux and runs the gate
normally.

## Only what changed

Owner, 2026-11-08: pre-push runs tests only for what changed; unchanged areas
are not re-tested there at all, and the full set stays in CI.
`scripts/gate/affected.ts` (logic in `scripts/gate/affected-lib.ts`, tests in
`unit/affected-gate.test.ts`) does the selecting, and prints what it picked and
why before it runs anything:

```bash
bun scripts/gate/affected.ts plan            # what a push would run now, and why
LIANKI_GATE_CHANGED="lib/dates.ts" bun scripts/gate/affected.ts plan   # "what if I changed …"
LIANKI_GATE_FULL=1 git push                  # the full local gate, as before
```

**Changed files** are the pushed commits (the hook passes their SHAs) against
their merge base with `origin/main`, plus uncommitted edits to tracked files,
since the tests run on the working tree. It does not fetch: a stale
`origin/main` only makes the diff, and so the selection, bigger.

**The graph** is static and errs toward running more. Every string literal in a
code file that names a repo file is an edge: imports (`@/` and the other
tsconfig aliases, relative paths, `index` files, `.js` → `.ts`), `await
import()`, `mock.module()`, and also `readFileSync("app/fsrs.ts")` or
`new URL("../worker.ts", import.meta.url)` in tests that read source. In
`unit/**`, a literal naming a directory or a glob makes the test depend on
everything under it (tests that walk `app/api` or scan `scripts/**`). An
intlayer `useIntlayer("key")` reaches the `*.content.ts` declaring that key.
A data file that lists paths it never loads opts out with the pragma
`affected-gate: imports-only` (`scripts/qa/suites.mjs`). The literals per file
are cached in `node_modules/.cache/lianki-affected/`, keyed by mtime and size;
a selection takes ~40 ms warm, ~250 ms cold.

**Unit:** the test files whose import closure contains a changed file, run
without coverage (`scripts/gate/bunfig.affected.toml`) — bun's per-file 90%
threshold cannot hold on a subset. **qa:** a suite runs when its own entry file
(or anything it imports or reads) changed, or when a file the change reaches
matches one of the suite's `paths` in `scripts/qa/suites.mjs` — route trees
such as `app/(app)/words/**`, so `lib/words/x.ts` reaches WORDS through
`app/(app)/words/page.tsx` without being listed. They run through
`qa-all.mjs --suites=<id>,…`; when no chosen suite needs the Worker (the
serverless READ SEL ones), the OpenNext build and `wrangler dev` are skipped
too. No suite matched → none run, and it says so.

**Falls back to everything** — the full unit suite with coverage, the full
qa:all — when one of these changed (the lists are `UNIT_FULL` and `QA_FULL`
in `affected-lib.ts`): `package.json`, `bun.lock`, `bunfig.toml`,
`tsconfig.json`, `patches/**`, `unit/support/**`, the selector itself
(`scripts/gate/**`), `.husky/pre-push`, the shared core `lib/d1/**`, `auth.ts`,
`app/db.ts`; for qa also the Worker's build and serving (`next.config.*`,
`open-next.config.ts`, `wrangler.jsonc`, `worker.ts`, `proxy.ts`,
`intlayer.config.ts`, `db/migrations/**`) and qa:all's own machinery
(`qa-all.mjs`, `gate-suites.ts`, `suites.mjs`, `silent.mjs`, `load-budget.mjs`,
`machine-lock-lib.ts`). Also when there is no merge base with `origin/main`, or
the graph cannot be built.

What a static graph cannot see, CI can: a test that reaches a file only through
a computed path, or a suite whose route was not mapped, still runs in full on
the PR (unit + coverage) and in the merge queue (qa:all) before anything lands.
When CI fails on something the local gate skipped, add the edge — a literal, a
`paths` glob — rather than widening the fallback list.

## Admission by load

Time-sensitive suites go through one machine-wide gate, and the gate admits by
the machine's **actual load**, not by a number of runs (owner, 2026-11-08). Until
then it was one run at a time, and each agent ahead in the queue added a whole
gate, about 6 min (measured 2026-11-08: lint 0.7 s, typecheck 1.8 s, unit +
coverage 47 s, qa:all 295 s, of which qa-words 209 s). qa-words now runs its
phone matrix and WebKit iPhone passes at once, each in a context with an
account of its own, beside its desktop flow: 76–83 s at load 7 on 18 cores.

**What waits and what does not.** Lint, typecheck, the unit suite, the OpenNext
build, `wrangler dev` and the plain qa suites start at once: they are CPU work,
not timing checks. Only the qa suites tagged `sensitive: true` in
[`scripts/qa/suites.mjs`](../scripts/qa/suites.mjs) wait for admission, which
qa:all asks for after the plain suites (`scripts/qa/gate-suites.ts`). The tags
are that one list. Today they cover WORDS, READ EPUB, READ SEL ONE, SYNC and
PARTNER FRAME, the suites that failed under load in the push logs. No unit test
has shown a timing failure, so none is tagged.

**The admission rule** (`admission()` in `scripts/dev/machine-lock-lib.ts`, unit
tested with injected load and memory):

- Nothing else holds the gate → **admitted, always**, however busy the machine
  is, so nobody starves.
- Otherwise it is admitted only while **all** of these hold:
  - the 1-min load average is under `LIANKI_GATE_LOAD_RATIO` × cores (default 0.9);
  - free + inactive + speculative memory (`vm_stat`; `os.freemem` elsewhere) is at
    least `LIANKI_GATE_MIN_FREE_GB` (default 2);
  - the newest holder has run at least `LIANKI_GATE_SETTLE_S` (default 15). The
    load average lags, and a burst of waiters must not all see the same idle
    moment.
- Two waiters can be admitted in the same moment. The one that got its slot later
  backs off and waits again; ties go by token.
- **The count is not a limiter.** `LIANKI_GATE_MAX_RUNS` (default: the core count)
  is only a high safety cap.

A waiter prints why it waits (`waiting: load 17.2/16.2 is too high (mem 5.1 GB
free)`, or memory, or settling), and who holds the gate (pid, worktree, command,
start time). After that it prints at most one line a minute. It reads the slot
files every 3 s, so it sees a holder leave at once. It measures load and memory
at most every 15 s, and again whenever the set of holders changes.

**Load budgets in the suites.** Several runs at once only work because the suites
budget for load rather than for an idle Mac. Every QA browser context gets
Playwright's 30 s default as a load budget, so do the Playwright runner's test
and expect timeouts, and each explicit `timeout:` in a qa:all suite is
`budget(ms)` (`scripts/qa/load-budget.mjs`). A budget is the idle figure times a
factor: 1 until the load reaches half the cores, growing to at most 4
(`LIANKI_QA_SLOWDOWN` sets it by hand). Only how long a check may take changes,
never what it checks. An interval the test itself must keep short is not scaled:
`qa-read-sel-one` measures the gap between its two quick taps' pointerdowns in
the page. When the machine made them slower than the double-click interval, it
taps the pair again rather than judging a pair that was not quick.

**Failure log, for tuning.** Every failed qa:all suite appends one line to
`/tmp/lianki-gate-failures.jsonl` (`LIANKI_GATE_FAILURE_LOG` overrides it). The
line holds: suite, sensitive or not, exit, duration, 1- and 5-min load, cores,
free GB, the number of gate runs at the time, and the worktree. Tune the
thresholds from those lines, not from a guess. A suite that fails at low load is
a real failure.

| Run                                              | Gate                                                    |
| ------------------------------------------------ | ------------------------------------------------------- |
| `git push` (pre-push)                            | only qa:all's time-sensitive suites wait for admission  |
| `bun run qa:all`, `bun scripts/qa/qa-all.mjs`    | the same: plain suites at once, sensitive ones admitted |
| `bun run test:unit`, `bun test`, lint, typecheck | no                                                      |
| a single `qa-*.mjs` or Playwright suite, by hand | no                                                      |
| `bun scripts/dev/machine-lock.ts -- <cmd>`       | admits `<cmd>` as a whole, by the same rule             |
| CI (`CI` set)                                    | no: each runner has its machine to itself               |

Rules it keeps:

- **Each run holds one slot file** (`/tmp/lianki-gate.lock`, `.lock.2`, …) with
  the lock rules below. Slot 1 is the old single lock's path, so a wrapper from a
  branch made before this change still meets this one there.
- **Dead holders are taken over, live ones never.** Dead means the pid is gone, a
  zombie, or now belongs to a process with another start time (pid reuse). Age
  counts for nothing: past 30 minutes a waiter prints a warning and keeps waiting.
  If `ps` can't answer, a pid that exists counts as alive.
- **Released on exit, failure and signals.** INT, TERM and HUP go to the command,
  and the lock is held until the command is gone. After a `kill -9` of the wrapper
  the command can outlive it; the next waiter takes over, so the two can overlap.
- **Nested use just runs**: the holder hands its token down in the environment
  (`LIANKI_GATE_TOKEN`), and a run inside it sees that token in whichever slot it
  sits in. A token from a finished run does not count.
- **It sits outside the per-checkout lock** in `qa-all.mjs` (`.wrangler/qa-all.lock`):
  one qa:all per checkout. Waiters are not served in arrival order. If the file
  can't be used at all it warns and runs without the gate, so a broken `/tmp` never
  pushes anyone towards `--no-verify`.

**Don't loop failed pushes.** The hook is one attempt, and nothing in code retries.
If a time-sensitive suite times out, look at the load first (`uptime`); if it is
high, wait for it to come down, then retry once. A second failure is a real failure:
read it.

WebKit traps the suites already avoid (2026-11-07, `qa-words`; 2026-11-10, `qa-sign-out`):

- **Waiting for the network.** `waitUntil: "load"` or `"networkidle"` hung 30 s
  in WebKit at load 6–10, on requests no check needs. Navigate with
  `waitUntil: "commit"` and wait for the page's own readiness: `/words` sets
  `data-ready` on its `[role="list"]` once it is measured and opened.
- **`<url> due to access control checks.` as a page error.** WebKit says this
  about a fetch the old page _starts_ while the next page loads, caught or not;
  under load that window is seconds long. Fix the page (`lib/page-leaving.ts`:
  start nothing from `beforeunload` on — `pagehide` is too late) rather than filtering
  the message; a filter, if any, is for one URL and only while the suite's own
  navigation is under way.
- **A `goto` that never commits, with no request in the wrangler log.** That was
  the app's service worker, not the harness (2026-11-10, `qa-sign-out`): it wrote
  a response's clone to the cache in the background, and when the page left
  before that response finished, WebKit never started the next navigation.
  `public/sw.js` `keep()` now finishes the write before the page gets the
  response. To check a WebKit-only hang like it, run the suite in the CI image
  (`mcr.microsoft.com/playwright:<version>-noble`, `--network host`) against a
  local `wrangler dev`, and compare with `serviceWorkers: "block"` on the context.

The manual `mkdir /tmp/lianki-push.lock` from older agent briefs is no longer needed:
drop it. It stays safe while some agents still use it, because the order only runs
one way: they hold the old lock and then enter the new one, and nothing holding the
new lock ever takes the old one.

## Source maps (off since 2026-11-10)

`wrangler deploy` uploads source maps by default. Ours (wrangler's bundle of
`worker.ts` plus the OpenNext build) reached 61.6 MiB, over Cloudflare's 60 MiB
limit (error 10021), and every deploy failed. `wrangler.jsonc` now sets
`"upload_source_maps": false`: stack traces in Workers Logs and `wrangler tail`
show bundled positions. To turn maps back on, first shrink them under the limit
(e.g. build with `--outdir`, drop `sourcesContent`, then deploy that bundle).

## Deploy order

`.github/workflows/deploy-worker.yml` runs after CI passes on `main`: OpenNext
build, route fingerprints (see "Smart refresh" below), asset hygiene, **Worker exports unchanged**
(`scripts/ci/check-worker-exports.ts`), D1 migrations, then the Workers in
this order:

1. `lianki-monitor` — the main Worker names it as its tail consumer.
2. `lianki` (the main Worker) — before lianki-push, because lianki-push binds
   one of its named RPC entrypoints (`SESSIONS` → `lianki#DebugSessions`,
   `worker.ts`). A binding to an entrypoint the callee does not export yet can
   be refused at deploy time, which would stop the run and keep main from
   updating; Cloudflare's advice is to deploy the callee first
   ([service bindings, deployment](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/#deployment)).
3. `lianki-push` — the reverse direction needs nothing new: the main Worker's
   `PUSH` binding is to lianki-push's default `fetch`, which already exists,
   and a route lianki-push adds later is only called with a fallback (the
   sign-out notice goes to the D1 outbox until lianki-push answers).
4. `lianki-voice` — last and non-blocking.

Until 2026-11-02 lianki-push went before `lianki`; that was fine while every
binding between them was a plain one. Adding a new entrypoint or RPC method:
keep the callee first. Removing one: deploy the caller without the binding
first, then the callee.

`worker.ts` is the main Worker's entry: it re-exports everything the OpenNext
build exports (`export *`, and the whole default handler) and adds
`DebugSessions`. Its `fetch` has one check in front of OpenNext's, the
owner's same-origin live preview (`lib/live-view/page-proxy.ts`): a request
with no `live=` and no live cookie goes straight through. The export check bundles it like the deploy does
(`wrangler deploy --dry-run`) and fails the run if the set differs from the
build's own plus `DebugSessions`.

## Smart refresh: "New version · Refresh" only for changed pages

Owner, 2026-11-09: invite a refresh only when something changed on the page
he is on. A deploy that touches other pages, the API, D1 or the Workers stays
silent.

**At build time** `scripts/build/route-fingerprints.ts` (a deploy step, right
after the OpenNext build) reads the Next build's
`.next/server/app/**/page_client-reference-manifest.js` — for each route, the
client JS chunks and CSS of each layout and page it loads — and
`.next/build-manifest.json` (runtime and polyfills). It writes
`.open-next/assets/_lk/route-fp.json`:

```json
{ "build": "<sha20>", "shell": "<hash>", "routes": { "/words": "<hash>", "/read/[id]": "<hash>" } }
```

- `shell` hashes the content of what every page loads: runtime, polyfills,
  the root layout's chunks and the global CSS.
- each route hashes the content of its own chunks and CSS, minus the shell's
  (route groups dropped from the key: `/(app)/words/page` → `/words`). A
  change to `app/(app)/layout.tsx` moves every `(app)` route; a change to a
  component used by one page moves that page only.
- Content, not file names, and the build id is **never in client code**: it
  is `<html data-build>` (root layout), read by `lib/build-id.ts`. With the id
  inlined, the minifier picked different names in that chunk on every build,
  so every deploy looked like a shell change. Checked on real builds: the same
  code under two build ids gives identical fingerprints; a one-line change to
  `StatsClient.tsx` moves `/stats` alone.

**At deploy** the main Worker's first request per isolate
(`lib/announce-build.ts`) reads that asset through `ASSETS` and posts the build
id to lianki-push with the fingerprints in the `x-lk-fingerprints` header (the
body stays the bare id, so the lianki-push still running during the deploy
reads it as before). The VersionHub keeps fingerprints for the last 30 builds.

**On the page** (`app/components/VersionNotice.tsx`) the socket connects as
`/api/version/ws?b=<its build>`; the hub answers with what changed since that
build: `{build, shell: bool, routes: {"/words": 1, "/list": 0, …}, force?}`.
`refreshDecision` (`lib/smart-refresh.ts`) shows the button only if the shell
changed, the current route changed (or is new), the deploy is forced, or it
cannot tell (no fingerprints for the page's build — e.g. the first deploy with
this, or a page older than 30 builds — or a path no route pattern matches).
Otherwise the news is kept, and a soft navigation to a route that did change
shows the button then. Debug devices still auto-reload, but only when the
button would show. Version detection stays event-driven; it does not periodically
poll for new deployments.

**Before an automatic reload**, `lib/version-probe.ts` immediately fetches
`/_lk/route-fp.json` from the page's origin with `cache: no-store` and a probe
query. A successful response must contain valid fingerprints whose `build`
exactly matches the announced build. Otherwise it retries after 100, 200, 400,
then at most 800 ms between completed requests. A separate 2500 ms deadline
includes network and response-body time; exhaustion shows the manual Refresh
button and stops automatic work. Component cleanup cancels requests and timers.
A confirmed build still respects the existing dirty-page and idle/navigation
rules: readiness never overrides unsaved work, an active microphone or a study
session. Manual Refresh remains available without waiting for a probe.

**Forcing it for everyone** (a security fix, a broken client): put a
`Force-Refresh: yes` trailer on the commit that lands on `main` (or run the
step with `--force` / `LIANKI_FORCE_REFRESH=1`). The fingerprint file gets
`"force": true`, and every open page shows the button.

Tests: `unit/version-notice-probe.test.ts` (readiness, backoff, deadlines and
cancellation), `unit/smart-refresh.test.ts` (diff → decision), `unit/route-fingerprints.test.ts`,
the hub in `unit/debug-hub.test.ts`; `scripts/qa/qa-smart-refresh.ts` (qa:all
`smart-refresh`, serverless) runs the real hub and the real notice in Chromium
across builds that change another route, the current route, nothing
client-side, and a forced one.

## Branch protection — two mechanisms

Don't confuse them when debugging a rejected push:

- _Classic branch protection_ holds the required check (`Typecheck + unit`
  only — since 2026-11-08 the gate job in ci.yml that also waits for the
  merge-queue qa:all), `strict: false`,
  `enforce_admins: true`, and **no**
  required PR reviews. Read it with
  `gh api repos/snolab/lianki/branches/main/protection`.
  Merging goes through a **merge queue** (since 2026-10-31): `gh pr merge
<N> --auto` queues the PR, CI runs on the `merge_group` event against main
  plus the PRs ahead of it, and it merges only if that combination is green.
  Two PRs that are green apart and red together (#342 + #344 broke main that
  way) can no longer both land, and no one runs `gh pr update-branch` by hand.
  This replaced `strict: true`, which made every auto-merge PR stall as
  BEHIND whenever main moved. The queue is the `merge_queue` rule on the
  `cipass` ruleset.
- _Ruleset `cipass`_ (id 13053938) blocks deletion, force-push, and non-linear
  history. Read it with `gh api repos/snolab/lianki/rulesets/13053938`.
- Emergency override:
  `gh api --method DELETE repos/snolab/lianki/branches/main/protection/enforce_admins`.

## Auto-merge

`gh pr merge <N> --auto --squash` waits for both required checks, then merges.
The repo's "Allow auto-merge" setting must be ON (it is).

**Gotcha**: if that setting is OFF, `--auto` returns exit 0 but silently does
nothing. Confirm it armed with `gh pr view <N> --json autoMergeRequest` (should
be non-null). With no required checks, `--auto` merges _immediately_ — which is
why protection must stay in place.

## Publishing the CLI (npm `lianki`)

`packages/lianki-cli` goes to npm only through
`.github/workflows/release.yml`, never `npm publish` from a laptop. It
runs on a pushed tag `lianki-cli-v<version>`; the tag must sit on a commit
already on `main` and match `version` in its `package.json`. It packs the
tarball, smoke-tests it under Node in an empty folder, and publishes with
`--provenance`, authenticated through GitHub Actions OIDC (npm Trusted
Publishing), with no npm token. The npm trusted publisher must name
`snolab/lianki`, workflow `release.yml`, no environment, and allow direct
`npm publish`. The workflow uses Node 24 and upgrades npm (OIDC requires npm
11.5.1 or newer). A new trust must complete its first publish within 48 hours
or be recreated; subsequent successful publishes do not require recreating it.
Publishing is
outward-facing: the owner approves each release (tap card) before the tag is
pushed.

```bash
git tag lianki-cli-v0.2.0 <sha on main> && git push origin lianki-cli-v0.2.0
```

## QA after every deploy

Use remote Chrome AND Vercel logs together:

```bash
# 1. Navigate in remote Chrome, note any digest shown
# 2. Stream logs to find the real error behind the digest:
vercel logs https://lianki.com 2>&1 | head -80
```

Production Next.js hides error messages — the UI shows a digest, the real error
is in Vercel runtime logs. Match digest to confirm root cause. A repeated digest
after redeploy means the same error persists.
