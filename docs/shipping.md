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

## Branch protection — two mechanisms

Don't confuse them when debugging a rejected push:

- *Classic branch protection* holds the required check (`Typecheck + unit`
  only, since qa:all went nightly on 2026-10-31), `strict: true`,
  `enforce_admins: true`, and **no**
  required PR reviews. Read it with
  `gh api repos/snolab/lianki/branches/main/protection`.
  `strict: true` ("require branches to be up to date") is there because two
  PRs, each green against an older main, were squashed together and broke
  main's typecheck (#342 + #344, fixed in #347): a PR must now re-run the
  check on top of the current main before it merges. The check is ~20 s, so
  the cost is small; auto-merge PRs still need `gh pr update-branch <N>` (or a
  rebase) when main moves under them.
- *Ruleset `cipass`* (id 13053938) blocks deletion, force-push, and non-linear
  history. Read it with `gh api repos/snolab/lianki/rulesets/13053938`.
- Emergency override:
  `gh api --method DELETE repos/snolab/lianki/branches/main/protection/enforce_admins`.

## Auto-merge

`gh pr merge <N> --auto --squash` waits for both required checks, then merges.
The repo's "Allow auto-merge" setting must be ON (it is).

**Gotcha**: if that setting is OFF, `--auto` returns exit 0 but silently does
nothing. Confirm it armed with `gh pr view <N> --json autoMergeRequest` (should
be non-null). With no required checks, `--auto` merges *immediately* — which is
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
