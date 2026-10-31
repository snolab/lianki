# Passkey approvals for sensitive asks (design)

Status: **design, not built.** Requested by the owner on 2026-10-31 04:01 JST:
approve sensitive actions with a passkey (Face ID or a fingerprint) instead of
typing or speaking. It builds on the tap-to-answer **ask cards** (in progress
in a separate PR): an agent sends `{type:"ask", askId, question, options}`, the
owner's page answers, and the hub relays the answer stamped `source:"tap"`.

Background you need first: [monitoring.md](monitoring.md) ("Chat with the
agent": grants, tokens, scopes), [secrets-and-auth.md](secrets-and-auth.md)
("Passkeys"), `workers/push/src/debug.ts` (the hub) and `scripts/dev/eval.ts`
(the agent's CLI).

## The boundary rule (read this first)

> **An in-app approval authorises actions inside Lianki's own systems only:
> grants on the debug hub, and server-side operations behind a Lianki API that
> checks the signed approval itself. It never approves, bypasses or stands in
> for Claude Code's own tool-permission prompts or auto-mode safety checks on
> the Mac. Those still need the human at the terminal. An agent must never
> treat an in-app approval as permission for something its own harness
> refused, asked about, or would ask about, and must never change its harness
> settings (permissions, hooks, CLAUDE.md) because of one.**

Why it is a hard line rather than a preference:

- The approval is a signed statement that the **Lianki server** checks. Claude
  Code's harness never sees it, and nothing in this design makes the harness
  trust it. That is deliberate.
- A passkey proves that the owner approved _a described Lianki action_. It
  says nothing about a shell command the agent might run next. "He approved
  `grant.renew`" does not mean "he approved `wrangler secret put`".
- The harness prompt is the owner's last line of defence against an agent
  that is confused or compromised. If an agent could turn a chat-side tap into
  a harness bypass, compromising the chat would be enough to compromise the Mac.

What an agent **may** do with a verified approval:

1. Present it to the Lianki endpoint that performs exactly that action
   (the hub does this itself for grants).
2. Treat it as the owner's go-ahead for that same action, done in a way its
   harness already allows without asking (for example, a `bun scripts/…`
   call that only talks to the Lianki API the approval is for). That is no
   different from the owner saying so in the chat.

What it **may not** do: answer a harness prompt with it, argue the harness
should allow something because of it, reuse it for a different or wider
action, or keep it to use later than its expiry. When a harness prompt is in
the way, the agent says so in the chat ("this needs you at the terminal") and
waits.

## Tiers

| tier          | what the owner does                   | stamped `source` | for                                                                                                                             |
| ------------- | ------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **normal**    | one tap on an option                  | `"tap"`          | reversible, low-stakes choices: "A or B?", "ship the copy fix?", "keep the old icon?"                                           |
| **sensitive** | a tap on Approve, then a passkey (UV) | `"passkey"`      | renewing the eval or chat grant; production or auth changes; bulk changes to his real data (list restructuring); spending money |

A sensitive ask is not a normal ask with a flag the page can ignore. It
carries a typed **action** from a fixed registry, the hub computes its digest,
the hub **ignores every page answer** to it, and the only thing that settles it
is an approval signed by the main Worker after it verified the passkey.

Normal asks keep the existing contract unchanged. An agent must not use a
normal ask for anything in the sensitive list. The hub enforces this for the
actions it executes (a grant can only be renewed through a sensitive ask), and
each Lianki API that does something sensitive requires the signed approval
(see "Server-side actions").

## Actions and their digest

`lib/approval-actions.ts` (new, shared by the hub, the main Worker, the page and
the CLI) is the registry. Each action kind has a schema, a fixed English and
Chinese/Japanese **description template**, who executes it and how long an
approval stays usable:

| kind                | fields                                                                                                                                                         | executed by                       | approval usable for |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------- |
| `grant.renew`       | `scope` (`eval`\|`chat`), `mode` (`sliding` for eval: 8 h idle / 7 d cap; `fixed` for chat: 30 d), `label`, `tokenHash`, `pages` (eval: the confirming device) | the hub, at once                  | 60 s                |
| `lists.restructure` | `listIds[]`, `planDigest` (SHA-256 of the plan the API will apply), `counts`                                                                                   | `POST /api/lists/restructure`     | 10 min, once        |
| `prod.change`       | `target` (e.g. `auth.config`, `flags`), `diffDigest`, `summary`                                                                                                | the API that owns `target`        | 10 min, once        |
| `spend`             | `amountJpy` (integer), `payee`, `purpose`                                                                                                                      | the API that spends (payments.md) | 10 min, once        |

**Canonical form.** The action is serialised with sorted keys, no whitespace,
UTF-8, integers only (no floats), and `v:1`. `digest = base64url(SHA-256(canonical(action)))`.
Everyone recomputes it from the action; nobody trusts a digest sent to them.

**The description shown to the owner is rendered from the action by the
template, never from the agent's free text.** The agent's `question` is shown
too, smaller and labelled as the agent's words. So a malicious or confused
agent can write "renew the grant?" as its question, but if its action is
`spend {amountJpy: 50000}`, the card's headline reads "Spend ¥50,000 to …".
Times in descriptions are JST with a written-out date (`lib/dates.ts`),
e.g. "until 31 Oct 2026, 12:05 JST".

## Wire

New and changed messages, on top of the ask-card wire:

```text
agent → hub    {type:"ask", askId, question, options:["Approve","Deny"],
                tier:"sensitive", action:{kind, …}}
hub → pages    {type:"ask", askId, question, tier:"sensitive", action, digest,
                description, from:<agent label>, expiresAt}       (owner thread only)
page → main    POST /api/approvals/challenge {askId}
main → hub     GET  /internal/asks/<askId>        (PUSH binding)
page → main    POST /api/approvals/verify {askId, nonce, assertion}
main → hub     POST /internal/approvals {payload, sig}            (PUSH binding)
hub → agent    {type:"answer", askId, option:"Approve", source:"passkey",
                action, digest, approval:{payload, sig}, result?}
hub → pages    {type:"ask-settled", askId, source:"passkey", description, at}
```

"Deny" stays a plain tap (`source:"tap"`): refusing needs no proof. A sensitive
ask also settles as `expired` after 5 minutes, and only **one** sensitive ask
may be pending at a time (like a pairing), so the owner never has to tell two
apart.

## Server-side verification (main Worker)

The passkey is verified on the **main Worker** (`lianki`, the OpenNext app),
which already runs better-auth with `@better-auth/passkey` and owns the
`passkey` table. The plugin's own sign-in ceremony uses a random challenge
that it stores itself, so it cannot be bound to an action. The approval
ceremony therefore reuses the plugin's **data** (the owner's registered
credentials and the relying party from `lib/passkey.ts`) and calls the same
library the plugin is built on (`@simplewebauthn/server`) with a challenge we
construct:

**`POST /api/approvals/challenge {askId}`** (owner session cookie required;
404 for anyone else, like `/dev/users`):

1. Fetch the ask from the hub over the PUSH binding
   (`/internal/asks/<askId>`). The action comes from the hub, **not from the
   page**, so script on the page cannot swap it.
2. Recompute `digest`; re-render the description.
3. `nonce` = 16 random bytes; `exp` = now + 120 s.
   `payload = {v:1, askId, digest, userId:<owner>, exp, nonce}`;
   `challenge = base64url(SHA-256(canonical(payload)))`.
4. Store the row in D1 `approval_challenge` (`nonce` primary key, `ask_id`,
   `digest`, `user_id`, `exp`, `used_at NULL`). New migration.
5. Return `{challenge, nonce, rpId, allowCredentials:<owner's passkey ids>,
description, expiresAt}`.

**The page** calls `navigator.credentials.get({publicKey:{challenge, rpId,
allowCredentials, userVerification:"required", timeout:60000}})`. The OS draws
its own sheet (Face ID / Touch ID / fingerprint) over the page.

**`POST /api/approvals/verify {askId, nonce, assertion}`** (owner session):

1. Claim the challenge row atomically:
   `UPDATE approval_challenge SET used_at=? WHERE nonce=? AND ask_id=? AND used_at IS NULL AND exp>? RETURNING *`.
   No row → 409 (replayed, expired or for another ask).
2. Rebuild the expected challenge from the row and run
   `verifyAuthenticationResponse` with `expectedChallenge`, `expectedOrigin`
   and `expectedRPID` from `passkeyRelyingParty`, and
   `requireUserVerification: true` (the UV flag means biometrics or the
   device PIN was used, not just a tap).
3. The credential must be in `passkey` **and** belong to the owner's user id.
   Update its counter. (iCloud Keychain passkeys report a counter of 0
   forever, so replay protection comes from the one-time nonce, not the counter.)
4. Sign the approval with Ed25519 (WebCrypto, supported on Workers):
   `approval = {v:1, kid, askId, digest, userId, credentialId, verifiedAt, exp:verifiedAt+usableFor, nonce}`,
   `sig = Ed25519(APPROVAL_SIGNING_KEY, canonical(approval))`.
5. POST `{payload: approval, sig}` to the hub at `/internal/approvals`, and
   return 200 to the page (the page learns only "approved").

Keys: `APPROVAL_SIGNING_KEY` (Ed25519 private JWK) is a Worker secret on
`lianki` only, plus `.dev.vars` for local runs. The public key is a plain var
on `lianki-push` (`APPROVAL_PUBLIC_KEY`) and committed in
`lib/approval-key.ts` for the CLI and the APIs. `kid` allows rotation: the
verifiers accept the current and the previous key. Asymmetric on purpose: the
hub, the CLI and the agent can **check** an approval but cannot **make** one.
Add it to [secrets-and-auth.md](secrets-and-auth.md) when built.

Why sign at all, when `/internal/*` is reachable only over the service binding?
Because the approval also travels to the agent and on to other APIs, and each
of them must check it without trusting whoever handed it over. The binding
protects the delivery; the signature protects the meaning.

## The hub

On `/internal/approvals` the hub:

1. Verifies `sig` with `APPROVAL_PUBLIC_KEY` (by `kid`).
2. Checks the ask is pending, its stored `digest` equals `payload.digest`,
   `payload.exp` has not passed, and `used:<nonce>` is not in storage (then
   stores it, with the ask's expiry).
3. Marks the ask answered, `source:"passkey"`.
4. If the hub executes the action (`grant.renew`), does it now; otherwise
   only relays.
5. Sends the asking controller `{type:"answer", …, source:"passkey",
approval, result}` and the owner's pages `ask-settled`; logs
   `debug.approve` (askId, kind, digest, credentialId prefix) for
   `wrangler tail lianki-push`.

A page message that claims `source:"passkey"`, or any page answer to a
sensitive ask other than Deny, is dropped.

## First use case: renewing the eval grant (8 h) without `--pair`

With the sliding grant (next section) this ask is needed only to start an eval grant and once every 7 days at its cap, or after 8 idle hours; the flow below is the same in each case, and the card reads "Allow eval on this device: renews while you use it, up to 7 days (until 7 Nov 2026, 04:05 JST)". Today an eval grant lapses after 8 h, and the next `eval.ts` run pairs: it
prints a 4-hex code and the owner must compare it and tap Allow. With
passkey approvals the agent renews over the chat grant it already holds:

```text
 Mac (agent)                    lianki-push hub            owner's phone          lianki (main Worker)
 ───────────                    ───────────────            ─────────────          ────────────────────
 eval.ts renew --scope eval
   token = 32 random bytes  (stays on the Mac)
   tokenHash = SHA-256(token)
   ask{tier:sensitive, action:{grant.renew, eval, 8h, label, tokenHash}}
        ──── over the chat-grant socket ───▶
                                 digest, description
                                 ── ask card ──────────────▶ "Renew eval grant for 8 hours
                                                             for 'agent on taku-mac' —
                                                             until 31 Oct 2026, 12:05 JST"
                                                             [Approve] [Deny]
                                                             tap Approve
                                                                ── challenge {askId} ──▶ fetch ask from hub,
                                                                                         build challenge
                                                                ◀── challenge, nonce ──
                                                             Face ID sheet (OS)
                                                                ── verify {assertion} ─▶ verify UV + owner
                                                                                         credential, claim
                                                                                         nonce, sign
                                 ◀──────────── /internal/approvals {payload, sig} ───────
                                 verify sig, digest, nonce
                                 putGrant(tokenHash, {eval, until:+8h, label, pages})
        ◀── answer{source:passkey, approval, result:{until}}
   check sig (lib/approval-key.ts), digest = own action
   write .debug-eval-token.json {token, until}  (mode 600, main checkout root)
 eval.ts serve / eval.ts '<code>'  resumes with x-debug-token: no prompt
```

Where the token lands: `.debug-eval-token.json` at the root of the main
checkout (gitignored, mode 600, `LIANKI_EVAL_TOKEN_FILE` overrides), written by
the same `saveTo` that pairing uses, so `serve`, `eval` and `say` pick it up
unchanged.

**Nothing secret passes through the chat or the hub.** The token is generated
on the Mac and never sent anywhere until the CLI uses it as `x-debug-token`
on its own TLS connection, exactly as today. The ask, the card, the chat line
and the logs carry only `tokenHash` (already what the hub stores as
`grant:<hash>`), the description and the digest. The approval is a signed
statement, not a credential: it is bound to that `tokenHash`, single-use and
dead after 60 s, so even a leaked approval cannot make a grant for a different
token. This differs from pairing (where the hub generates the token and hands
it over the socket); for `grant.renew` the hub stores the hash it was given.

Details:

- `eval.ts renew [--scope eval|chat] [--hours N]` sends the ask; `serve` and the
  eval command offer it automatically instead of pairing when a chat grant is
  live and the eval grant has lapsed (or lapses within 15 min). `--no-pair`
  stays as is: no ask is sent either.
- Renewing the **chat** grant (30 days) works the same way, but needs a live
  socket to ask over: a still-valid chat grant, or a live eval grant. If both
  have lapsed, there is nothing to ask through and the CLI pairs as today.
- Pages: a renewed eval grant reaches the same pages as the one it replaces,
  or all pages if the action says so; the description says which.
- End on the session still revokes the renewed grant, as any other.
- No passkey registered on the owner's account: the card says so with a link to
  Profile ("Add a passkey"), and the agent falls back to pairing.

## Sliding eval grant: renews itself while he uses the device

Owner, 2026-10-31 04:04 JST: "while I'm using it, it should refresh
automatically; I shouldn't have to renew by hand", and "extend the grant to 7
days for this device". So the eval grant stops being a fixed 8-hour window
and becomes a **sliding** grant with an idle timeout and a hard cap. The passkey
is needed only to start one, and again at the 7-day cap.

| rule         | value                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| idle timeout | 8 h with no activity from a bound page (`EVAL_IDLE_MS`, the old `EVAL_GRANT_MS` value)                                                                        |
| absolute cap | 7 days from the last passkey confirmation (`EVAL_CAP_MS`), then a `grant.renew` sensitive ask (passkey) is required                                           |
| bound to     | the grant's page ids: the device/tab that did the passkey confirmation (and pages he adds with "Add this page")                                               |
| renews from  | only activity on an owner-authenticated page socket whose id is in the grant's `pages` (never the agent, never a friend's page, never another of his devices) |
| chat grant   | unchanged and separate: 30 days fixed (`CHAT_MS`), no sliding                                                                                                 |

**Event-driven, no timer.** The hub moves the expiry forward on events it
already receives from a bound page, and on nothing else:

- a chat line `{type:"chat"}` from that page;
- the page's own messages: `{type:"page"}` (navigation), an ask answer;
- a new `{type:"active"}` the page sends on `visibilitychange` → `visible`,
  and on the first `pointerdown`/`keydown` after it has been sent ≥ 10 min
  ago (a gate on real input, not a timer; nothing is sent while he does
  nothing);
- a bound page's socket (re)connecting while the tab is visible.

`page-error` lines, heartbeat (`busy`) sockets and anything a controller sends
never count: the agent cannot keep its own grant alive. Expiry is still
checked lazily on the next event, as today.

On an activity event from page `id`, for every eval grant `g` with
`g.pages` containing `id`:

```text
g.lastActive = now
g.until      = min(now + EVAL_IDLE_MS, g.capUntil)
```

Storage is written only when `until` moved by more than 5 min (bounds DO
writes when he is busy), and the controllers holding `g` get
`{type:"extended", until}` so the CLI rewrites `until` in
`.debug-eval-token.json` (the token is unchanged).

**How the grant model in `workers/push` changes**

| today (`debug.ts`, `lib/dev-eval.ts`)                | sliding                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `EVAL_GRANT_MS = 8 h`, fixed                         | renamed `EVAL_IDLE_MS = 8 h`, plus `EVAL_CAP_MS = 7 d`                                                                                                                                                                                                                                                                                                       |
| `Grant = {label, until, scope?, pages?, at?}`        | adds `capUntil` (confirmation + 7 d), `lastActive`, `confirmedBy` (passkey `credentialId` prefix and the `nonce` of its approval), `renewals` (count)                                                                                                                                                                                                        |
| `until = at + EVAL_GRANT_MS`, never moves            | `until = min(lastActive + EVAL_IDLE_MS, capUntil)`, moved by bound-page activity                                                                                                                                                                                                                                                                             |
| `pages` absent = all pages                           | a sliding grant **must** have `pages`: no "all", so no other device can keep it alive (an old grant without `capUntil` keeps today's behaviour until it lapses)                                                                                                                                                                                              |
| `pages` are tab ids (`lk:debug-tab`, sessionStorage) | the same ids. A new device id in localStorage (`lk:debug-device`) is added so "this device" survives closing the tab; the grant stores both. Hardening (phase 6): a non-extractable WebCrypto key in IndexedDB per device, its public key recorded at confirmation, and the page signs the hub's connect nonce, so a copied id alone cannot claim the device |
| created by Allow on a pairing                        | created or re-confirmed by a passkey `grant.renew` ask (`mode:"sliding"`), answered **on the device it binds to**: the page that runs the ceremony becomes `pages`. Pairing stays as the fallback with today's fixed 8 h                                                                                                                                     |
| End revokes one session                              | End as today, plus **End all**: one tap in the owner menu that deletes every `grant:` (eval and chat) and `ngrant:`, closes every controller (4401) and records it in the audit log                                                                                                                                                                          |

**Audit log.** Each start, re-confirmation, extension that moved `until`
(coalesced: one entry per grant per hour at most), lapse, End and End all is
appended to the hub's storage as `audit:<seq>` `{at, kind, grant:<hash
prefix>, label, page, until, capUntil}` (last 1000 kept) and logged as
`debug.extend` / `debug.confirm` / `debug.endall`. The owner menu shows the
list with times in JST; the agent can read it with `eval.ts audit`.

**Risk, and what bounds it.** A stolen **unlocked** phone with a bound page
open keeps eval access alive for as long as someone keeps using it, and for at
most `EVAL_IDLE_MS` (8 h) after the last use; a locked phone cannot produce
activity unless its page is in front of an unlocked screen. It can never go
past `capUntil` (7 days from the last passkey), and re-confirming then needs
the passkey, so biometrics. Sensitive asks always need the passkey, so the
grant alone cannot renew a chat grant, make changes in production, restructure
his lists or spend money. On top: End all (one tap, from any of his
signed-in devices), the audit log, and deleting the passkey on `/profile`.
Optional, to decide on: a shorter idle window (say 2 h) when the page is not
the installed PWA.

## What an agent receives and how it may act

The agent's CLI prints one JSON line:

```json
{
  "type": "answer",
  "askId": "a_7f3c…",
  "option": "Approve",
  "source": "passkey",
  "action": {
    "v": 1,
    "kind": "grant.renew",
    "scope": "eval",
    "hours": 8,
    "label": "agent on taku-mac",
    "tokenHash": "…"
  },
  "digest": "Qm9…",
  "approval": {
    "payload": {
      "v": 1,
      "kid": "2026-10",
      "askId": "a_7f3c…",
      "digest": "Qm9…",
      "exp": 1793420765000,
      "nonce": "…",
      "verifiedAt": 1793420705000,
      "credentialId": "…",
      "userId": "…"
    },
    "sig": "…"
  },
  "result": { "until": 1793449505000 }
}
```

Before acting, the agent (the CLI does this for it) checks that `sig`
verifies with the committed public key, that `digest` is the digest of **the
action it sent** (recomputed, not copied), that `askId` is its own, and that
`exp` has not passed. Then:

- **Hub-executed actions** (`grant.renew`): already done; the CLI saves the token.
- **API-executed actions**: send the request whose body is exactly the
  approved action, with `x-lianki-approval: base64url(canonical({payload, sig}))`.
  The API (helper `requireApproval(req, kind)` in `lib/approval.ts`)
  recomputes the digest from the request body, verifies `sig`, and consumes
  `payload.nonce` in D1 (`approval_used`), so each approval runs once.
- Anything else: see the boundary rule at the top. The approval does nothing
  outside Lianki.

`source:"tap"` answers are never enough for a sensitive action: an API that
requires an approval rejects a request without one, whatever the chat said.

## Threat model

| threat                                                            | what stops it                                                                                                                                                                                                                                                                                            | what is left                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Stolen phone** (unlocked or not); see also "Sliding eval grant" | `userVerification:"required"`: the assertion needs Face ID, a fingerprint or the device passcode, and the server rejects one without the UV flag. A session cookie alone settles nothing.                                                                                                                | A thief who also knows the device passcode can pass UV. Mitigations: the owner ends the session on `/profile` and deletes the passkey; every sensitive approval is echoed to Slack #lianki, so an unexpected one is visible at once.                                                                                                                                                                                                                                                                                                                                                 |
| **XSS on lianki.com**                                             | Script on the page cannot create an ask (only controllers can), cannot choose the action (the challenge is built from the hub's copy), cannot produce an assertion without the owner's biometric gesture, and cannot get an approval for a different action (the challenge commits to `askId` + digest). | Script could draw a misleading card over a real pending ask and induce a Face ID tap. Limited by: one pending sensitive ask at a time, a 5-min ask and 2-min challenge, the OS's own native sheet (not drawable by the page; it names `lianki.com`), and the Slack echo of the server-rendered description. WebAuthn has no transaction-text display in today's browsers, so the action text lives in the card. Hardening (phase 6): run the ceremony on a dedicated `/approve/<askId>` route with a strict CSP (`script-src 'self'` with nonces, no third-party script, no widget). |
| **Malicious or confused agent**                                   | It can ask, but cannot forge an approval (no signing key; Ed25519 is asymmetric). The card's headline comes from the action template, not its words. The hub executes only registry actions and the APIs check the digest against the body they run.                                                     | It can spam asks, limited to one pending sensitive ask and the hub's rate limit. It can ask for something the owner then approves by mistake: the description is the defence. And it can't use an approval outside Lianki (boundary rule).                                                                                                                                                                                                                                                                                                                                           |
| **Replay**                                                        | One-time `nonce` claimed atomically in D1 at verify; `used:<nonce>` in the hub; API-side `approval_used`; short `exp` everywhere; the challenge expires in 120 s. A captured assertion is useless against any other challenge.                                                                           | None known for the protocol. The signing key must stay a secret on `lianki` only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Approval reused for another action**                            | The digest is in the signed payload and is recomputed by every verifier from the action it is about to execute.                                                                                                                                                                                          | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Friend accounts**                                               | Sensitive asks are shown only in the owner thread; challenge and verify are owner-only (404 for anyone else); the credential must belong to the owner.                                                                                                                                                   | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Compromised hub (lianki-push)**                                 | It cannot mint approvals for the APIs (no private key).                                                                                                                                                                                                                                                  | It could create grants by itself, as it already can today: grants live in the hub. Unchanged by this design.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## Phases (agent hours)

Estimates in agent hours: agent wall-clock time, assuming the ask-card PR has
landed.

| phase    | work                                                                                                                                                                                         | agent hours      |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 1        | `lib/approval-actions.ts` (registry, canonical JSON, digest, description templates in en/zh/ja), `lib/approval-key.ts`, Ed25519 sign/verify helpers + unit tests                             | 1.5              |
| 2        | Main Worker: `/api/approvals/challenge` and `/verify`, D1 migration `approval_challenge`, owner-only gates, signing secret in `.dev.vars` and on `lianki`; tests with recorded assertions    | 3                |
| 3        | Hub: sensitive asks (schema, one pending, expiry), `/internal/asks/<id>`, `/internal/approvals` (verify, nonce, execute `grant.renew` from a given `tokenHash`), page answers dropped; tests | 3                |
| 4        | Page: the sensitive card (server description, agent's words, JST expiry, Approve/Deny), the WebAuthn call, errors (no passkey, cancelled, expired), Slack echo                               | 2.5              |
| 5        | CLI: `eval.ts renew`, auto-offer instead of pairing, local signature check, token saved; docs (monitoring.md, secrets-and-auth.md)                                                           | 1.5              |
| 6        | QA: `qa-ui.mjs` end to end with the CDP virtual authenticator (UV on), negative cases (replay, wrong digest, expired, UV off, friend account); `/approve/<askId>` strict-CSP route           | 3                |
| 6b       | Sliding eval grant: `EVAL_IDLE_MS`/`EVAL_CAP_MS`, new grant fields, activity events and `{type:"active"}`, `extended` to the CLI, device id, audit log, End all; tests                       | 3.5              |
| **1–6b** | **first use case shipped: passkey-confirmed eval grant that slides while he uses the device, 7-day cap; chat grant renewal by passkey**                                                      | **18**           |
| 7        | Device key hardening (IndexedDB key, signed connect nonce)                                                                                                                                   | 2                |
| 8        | `requireApproval` for APIs, then each sensitive API one by one (list restructure first)                                                                                                      | 2 + ~1.5 per API |
