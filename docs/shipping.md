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

The `pre-push` hook runs `bun run lint`, typecheck and the same `qa:all` on every
pushed commit, so it is the per-change integration gate and a `--no-verify` skip
lets a broken commit reach main until the nightly run. It skips automatically for
deletion-only pushes, and on **native Windows** (Git Bash), where the OpenNext
Cloudflare packaging cannot produce a working Worker (symlink copy errors with
bun's isolated linker, `ChunkLoadError` on every route with a hoisted install;
verified 2026-10-14). There the nightly run is the only integration gate; `LIANKI_QA_ON_WINDOWS=1` forces
the local run, for example to re-test after an OpenNext upgrade. WSL counts as
Linux and runs the gate normally.

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
`DebugSessions`. The export check bundles it like the deploy does
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
