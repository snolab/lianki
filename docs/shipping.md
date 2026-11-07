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

## CI

`.github/workflows/ci.yml` runs on PRs and pushes to `main`: one job,
`Typecheck + unit` (oxlint + `oxfmt --check`, typecheck, unit tests with
coverage, ~20 s). It is the only required check, and the only thing main's
deploy waits for. When it fails on a push to `main` it posts to Slack #lianki.

The integration gate, `qa:all (D1/Workers)` (`bun run qa:all` plus the
extension smoke test, ~4 min), runs **nightly** on main at 03:00 JST in
`.github/workflows/nightly-qa.yml` (or by hand: `gh workflow run nightly-qa.yml
-R snolab/lianki`), and posts to #lianki when it fails. It left the per-push CI
on 2026-10-31 so a deploy no longer waits for it. Node 24 (for `node:sqlite`);
wrangler runs D1 locally, so no Cloudflare secrets are needed. Both alerts need
the repo secret `SLACK_WEBHOOK_URL` (`scripts/ci/slack-alert.sh`); without it
they only leave a workflow warning.

## Local hooks

Split by speed since 2026-11-04 (a commit used to run typecheck and the whole
unit suite, 30 s to several minutes):

- **`pre-commit`** — seconds, staged files only: secretlint, oxlint `--fix` +
  oxfmt on staged JS/TS (`.lintstagedrc.mjs`), and the generated copies only
  when their inputs are staged — userscript build, `@version` check,
  `lianki.meta.js` / `lib/userscript-version.ts` sync, the state-tree and blog
  bundles (`scripts/pre-commit.ts`, plan in `scripts/pre-commit-plan.ts`).
- **`pre-push`** — cheapest first, so a failure surfaces in seconds:
  `bun run lint` (whole repo), typecheck, the unit suite with its coverage
  gate, then `qa:all`. The last two run behind the machine-wide lock, below.

So a commit can be locally unchecked for types and tests until it is pushed;
nothing reaches `main` that way, because `main` takes only PRs and the required
CI check runs lint, typecheck and the unit suite with coverage on each one. The
generated copies are each pinned by a unit test (`unit/state-tree.test.ts`,
`unit/blog-corpus.test.ts`, `unit/userscript-version.test.ts`), so a missed
regeneration fails pre-push and CI.

The `pre-push` hook's `qa:all` makes it the per-change integration gate, and a
`--no-verify` skip lets a broken commit reach main until the nightly run. It
skips automatically for deletion-only pushes. On **native Windows** (Git Bash)
it skips `qa:all` only — lint, typecheck and the unit suite still run — because
the OpenNext Cloudflare packaging cannot produce a working Worker there (symlink
copy errors with bun's isolated linker, `ChunkLoadError` on every route with a
hoisted install; verified 2026-10-14). There the nightly run is the only
integration gate; `LIANKI_QA_ON_WINDOWS=1` forces the local run, for example to
re-test after an OpenNext upgrade. WSL counts as Linux and runs the gate
normally.

## One heavy run at a time

The unit suite and `qa:all` go behind one machine-wide lock, so parallel agents
queue instead of running at once: time-sensitive tests time out under load, and
that reads as a broken test. `scripts/dev/machine-lock.ts` wraps a command and
waits its turn; the lock is the file `/tmp/lianki-gate.lock`, the same path from
every worktree. A waiter prints who holds it (pid, worktree, command, start time)
and at most one line a minute after that.

| Run                                                                           | Lock                                                                         |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `git push` (pre-push): unit suite + `qa:all`                                  | held as one stretch, so nobody gets in between                               |
| `bun run qa:all`, with any flags                                              | takes it                                                                     |
| `bun run test:unit`, with flags only                                          | takes it                                                                     |
| `bun test unit/x.test.ts`, `bun run test:unit unit/x.test.ts`                 | no: a single file must stay fast                                             |
| bare `bun test` (the whole suite, by hand)                                    | no: bun's own command can't be wrapped. Heavy, so prefer `bun run test:unit` |
| `bun scripts/qa/qa-all.mjs` directly, a single `qa-*.mjs` or Playwright suite | no                                                                           |
| `bun run lint`, `bun run typecheck`                                           | no: measured 0.5 s and 1.8 s (6 s CPU) on 2026-11-07, and they fail fast     |
| CI (`CI` set)                                                                 | no: each runner has its machine to itself                                    |

Rules it keeps:

- **Dead holders are taken over, live ones never.** Dead means the pid is gone, a
  zombie, or now belongs to a process with another start time (pid reuse). Age
  counts for nothing: past 30 minutes a waiter prints a warning and keeps waiting.
  If `ps` can't answer, a pid that exists counts as alive.
- **Released on exit, failure and signals.** INT, TERM and HUP go to the command,
  and the lock is held until the command is gone. After a `kill -9` of the wrapper
  the command can outlive it; the next waiter takes over, so the two can overlap.
- **Nested use just runs**: the wrapper hands its token down in the environment
  (`LIANKI_GATE_TOKEN`), which is how pre-push reaches `test:unit` and `qa:all`
  inside its own hold. A token from a finished run does not count.
- **It sits outside the per-checkout lock** in `qa-all.mjs` (`.wrangler/qa-all.lock`),
  which remains for a direct `bun scripts/qa/qa-all.mjs`. Waiters are not served in
  arrival order. If the file can't be used at all it warns and runs unlocked, so a
  broken `/tmp` never pushes anyone towards `--no-verify`.

**Don't loop failed pushes.** The hook is one attempt, and nothing in code retries.
If a time-sensitive suite times out, look at the load first (`uptime`); if it is
high, wait for it to come down, then retry once. A second failure is a real failure:
read it.

Two WebKit traps the suites already avoid (2026-11-07, `qa-words`):

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

The manual `mkdir /tmp/lianki-push.lock` from older agent briefs is no longer needed:
drop it. It stays safe while some agents still use it, because the order only runs
one way: they hold the old lock and then enter the new one, and nothing holding the
new lock ever takes the old one.

## Deploy order

`.github/workflows/deploy-worker.yml` runs after CI passes on `main`: OpenNext
build, asset hygiene, **Worker exports unchanged**
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

## Branch protection — two mechanisms

Don't confuse them when debugging a rejected push:

- _Classic branch protection_ holds the required check (`Typecheck + unit`
  only, since qa:all went nightly on 2026-10-31), `strict: false`,
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
`.github/workflows/publish-cli.yml`, never `npm publish` from a laptop. It
runs on a pushed tag `lianki-cli-v<version>`; the tag must sit on a commit
already on `main` and match `version` in its `package.json`. It packs the
tarball, smoke-tests it under Node in an empty folder, and publishes with
`--provenance`, authenticated by the `NPM_TOKEN` repo secret. Publishing is
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
