---
name: prove-in-prod
description: Keep working on a Lianki change until it is proven working on lianki.com itself, with evidence; merged or deployed is not done. Load before marking any task done.
---

# Prove it in prod

Merged is not done. Deployed is not done. Done means you saw it work on
https://lianki.com and can show the evidence.

## 1. Define "proven" before you start

Write down two things, in the task's `--note`:

- the user-visible behaviour (what someone on lianki.com sees or gets);
- how you will observe it on prod (which page, API call, log line or version).

If you cannot name an observation, say so now: the task ends `--unverified` (step 5).

## 2. Merge, then confirm the deploy

Production runs `prod` ([docs/shipping.md](../../../docs/shipping.md)). After the merge:

```bash
gh run list -R snolab/lianki --branch prod --limit 5          # CI green on prod
gh run list -R snolab/lianki --workflow deploy-worker.yml --limit 3   # Deploy Worker succeeded
live=$(curl -s https://lianki.com/en | grep -o 'data-build="[^"]*"' | cut -d'"' -f2)
git fetch origin prod && git merge-base --is-ancestor <merge-sha> "$live" && echo LIVE
```

`data-build` is the first 20 characters of the deployed commit. No `LIVE`
means it is not out yet: a Full QA hold, a failed deploy, or the next release.
Find out which, and keep at it.

Userscript change: the served version must be yours.

```bash
curl -s https://lianki.com/lianki.meta.js | grep @version
```

## 3. Exercise it on prod

Use one of these, the most real one you can:

- **Real UI, headless:** a QA script against `https://lianki.com` with a QA or
  test account where one exists, always through `scripts/qa/silent.mjs`.
- **His Chrome, owner account:** `rech --profile snomiao@gmail.com`. He allows
  testing with his account: short, clearly labelled test lines, and "Allow
  once" on trust prompts. Never "always"; never change flags, settings or
  tokens; never approve auth, secret or delete cards for him.
- **Normal-user profile:** `rech --profile takuyokutou@gmail.com`, for checking
  what an ordinary user sees, including negative checks that owner-only
  features stay hidden.
- **Real API:** your lane's own token against the live endpoint.

Capture evidence: a screenshot path, a log excerpt (`wrangler tail lianki`),
an HTTP status, or a response snippet. A unit test or a local run is not
prod evidence.

## 4. Only then mark done

```bash
bun scripts/dev/progress.ts --agent <lane> --path /<route>/<task> --done --pr <N> \
  --verified "<evidence: what you saw, where>"
```

Tell him in Li (`lianki-dev say --as <lane> "…"`), short and spoken: what
works now and how you saw it. Example: 「滑动修复已在线上确认：iPhone 尺寸截图正常。」

## 5. If it cannot be proven

It needs his hand, his device or his account: mark `--unverified` (that
leaves the `verify:` child on you, with its own ETA) and tell him the one
step he must do, in one sentence. Never say 已上线 / 完成 / done without
also saying 未验证 / unverified.

## 6. Never claim facts unchecked

Say only what you have observed. If a later check contradicts something you
already told him, correct it in Li at once: what was wrong, what is true now.

## 7. Hard gates still apply

- No audio on his machine: silent QA only, no `say`, no TTS playback.
- No production user rows read out, copied or written; MongoDB is frozen.
- Auth, secrets, deletes and recording: a tap card from him first.
- Never `--no-verify`, never force-push.
