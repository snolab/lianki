# Owner-only paths: audit (2026-11-15)

Question: "我现在还有什么别的功能级别的特权吗？" Answer: **no gate in code names the
owner.** Every owner/dev/admin check already reads an `account_permission`
grant (`isDev` / `isAdmin` / `readHolders` / `holderIds`). What is left is
naming (the "owner thread" is the `dev` holders' dispatch thread) and a few
owner-specific _values_ that are not gates. Rule: AGENTS.md, "Gates are
permission grants"; [secrets-and-auth.md](secrets-and-auth.md), "Permissions".

## (a) Already a grant — no change

- `Identity.owner` (`/api/debug/identity`, `isDev`) and `/api/dev/whoami` (`isDev`): every hub "owner" decision starts here.
- Chat tokens `Verified.owner` (`lib/chat-token.ts`), eval tokens (`lib/eval-token.ts`), debug-session renewal (`lib/debug-session.ts`), partner ticket (`lib/partner-ticket-auth.ts`): `readHolders(db, "dev")`.
- Progress hub owner header (`workers/push/src/index.ts`): set only for `who.owner`.
- Chat log and inbox owners (`lib/chat-log.ts ownerIds`, `lib/inbox/agent.ts`): `holderIds(db, "dev")`.
- Partner AI refuses a `dev` holder (`lib/partner-ai.ts`); email change refuses any grant holder's address (`lib/profile/email-change.ts activeOwners`).
- /vibe (`lib/vibe/*`, `vibeAllowed(flags, isDev(…))`), live view (`page-proxy.ts isOwner` → `/api/dev/whoami`), local STT owner default (`owner` = the hub's `Identity.owner`).
- Flags with `audience: "owner"`: a label for /dev/flags (not on for everyone); each feature's gate adds `isDev` itself.

## (b) The owner thread in the hub = the dispatch thread (keep, now named)

Thread id `"owner"` (`lib/dev-eval.ts`), now `DISPATCH_THREAD`; `OWNER_THREAD` is
a deprecated alias so the hub's ~80 uses need no rename. Who joins: `threadFor`
(a `dev` holder) or a ticket socket minted only for one. Behaviours (all keep):

| Behaviour (workers/push/src/debug.ts unless noted)                    | Kind                                           |
| --------------------------------------------------------------------- | ---------------------------------------------- |
| Pages of `dev` holders join it; anyone else gets their own thread     | dispatch (membership by grant)                 |
| Lanes listen there; agent sockets default to it (`audience`)          | dispatch                                       |
| ETA / receipt / progress lines posted there                           | dispatch                                       |
| Learning Partner AI never replies there (friend threads only)         | dispatch                                       |
| D1 chat log put/backfill/drop; lines belong to all `dev` holders      | dispatch (`accountsOf`, `isDispatchThread`)    |
| Line merge/split, polish, auto-polish, two-mic merge, device sync     | dispatch (+ flags)                             |
| Voice clips from the page (recordings)                                | dispatch (+ `voice.recordings` flag, `dev`)    |
| Eval grants: listed, bound to and renewed on a `dev` session there    | grant (`Identity.owner` + session)             |
| `ownerGrant` html tier for agent lines (`rich-text.ts lineTier`)      | dispatch                                       |
| Chat tokens: a `dev` holder's token posts there (`token-chat.ts`)     | grant → `threadFor`                            |

None is an owner privilege in code: membership is the `dev` grant. The id
stays a constant on purpose: it is a storage key (hub prefixes, D1 `chat_line`
rows, packages/debug-chat's default) and `isUserId` excludes it, so an id from
config/env would orphan history or collide with an account's thread.

## (c) Owner checks elsewhere

- `siteOwner` (`lib/api-token-api.ts`): wired in `app/api/token/route.ts` to `isDevUser` — already the `dev` grant; kept, documented. `OWNER_SCOPES` (`eval`, `recordings:read`) are the scopes only a `dev` holder may mint.
- `isOwner(` (3): `api-token-api.ts` (= `siteOwner`), `page-proxy.ts` (= `/api/dev/whoami`), `vibe/gate.ts` comment — all `dev`.
- Whole-page dev server gate (`scripts/dev/preview-gate.ts`, `whole-page.ts`): the **oldest** active `dev` holder only. Grant-based; kept single-holder on purpose (it signs in on his Mac; widening it is a decision for him).
- Owner-specific values, not gates (follow-up: config keys, docs/config-store.md): `OWNER_DEFAULT_LOCAL_STT`, `DEFAULT_LOCAL_TTS_BASE`, `DEFAULT_CLONE_TTS_BASE` (his tailnet), `lib/live-view/origins.ts`. `lib/live-view/keys.ts` is a trust anchor and stays in code.
- `lib/progress.ts OWNER_NODE` / `OWNER_NAME`: the human's node in the state tree, a name, not a gate.
- Hardcoded addresses: none in gating code (only `@author` headers).

## Counts

(a) 12 grant-based paths, unchanged · (b) 10 hub behaviours, all the dispatch
thread, named (`DISPATCH_THREAD`, `isDispatchThread`, `threadFor`) · (c) 5 items:
0 hardcoded checks, 1 deliberate single-holder gate, 4 owner values for config.
No migration: no new permission row.
