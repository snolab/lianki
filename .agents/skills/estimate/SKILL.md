---
name: estimate
description: Get every time estimate (an --eta, an ETA you tell the owner, "how long will this take") from the estimate skill, never by guessing; it calibrates itself from the state tree's done history and its own log
---

# Estimates come from `estimate`, never from a guess

Owner, 2026-11-27: only someone never trained in estimating guesses this
wildly. Whenever you need a duration (a progress `--eta`, an ETA in Li, a plan
with times), ask the estimator. It reads how long similar done tasks really
took (the state tree's done history), blends that with a prior per kind, and
corrects itself from a local log of its past estimates and their actuals.

## Use

```bash
# In a progress report: the hub gets the estimator's P5-P95.
bun scripts/dev/progress.ts --agent <you> --path /x/y --task "Name: what" --status doing --eta auto:ui-fix

# On its own (to quote a time, or for batch items):
bun scripts/dev/estimate.ts "Fix the Gantt label overlap" --kind ui-fix --lane <you> --node /x/y
bun scripts/dev/estimate.ts "…" --eta-only        # just "12m-1h5m"
bun scripts/dev/estimate.ts "…" --guess 2h        # fold in your own hunch (scaled by your bias)
```

Kinds: `ui-fix`, `review`, `deploy`, `investigation`, `browser-automation`,
`backend-feature`, `docs`, `test`, `ops`, `other`. Leave it out and it is
guessed from the task. `--tags a,b` adds match words.

Quote the answer as it comes: the P5–P95 range (and the P50 if asked). Say
the sample size when it is small ("prior only", "3 similar tasks").

## Closing the loop (this is what calibrates it)

- An estimate made with `--node` (always, through `--eta auto`) closes itself:
  every estimator run syncs actuals from the done history.
- One without a node: `bun scripts/dev/estimate.ts close <id>` when the work
  is done (`--actual 40m` if you finish it later than the moment you close).
- `bun scripts/dev/estimate.ts stats [--lane <you>]`: coverage (share of
  actuals inside P5–P95, target 90%) and median actual/P50 per kind.

The log is `~/.config/lianki/estimates.jsonl` (or `LIANKI_ESTIMATES_LOG`):
local, never committed, never posted. The maths is `lib/estimate`
(docs/state-tree.md, "Estimates").
