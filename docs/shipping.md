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

`.github/workflows/ci.yml` runs on PRs and pushes to `main`: two jobs —
`Typecheck + unit` and `qa:all (D1/Workers)` (`bun run qa:all`). Node 24 (for
`node:sqlite`); wrangler runs D1 locally, so no Cloudflare secrets are needed.

The `pre-push` hook runs the same `qa:all` before anything leaves the machine, so
a `--no-verify` skip only defers the failure. It skips automatically for
deletion-only pushes.

## Branch protection — two mechanisms

Don't confuse them when debugging a rejected push:

- *Classic branch protection* holds the required checks (`Typecheck + unit`,
  `qa:all (D1/Workers)`), `strict: false`, `enforce_admins: true`, and **no**
  required PR reviews. Read it with
  `gh api repos/snolab/lianki/branches/main/protection`.
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
