# Secrets and auth

## Secret hygiene

- secretlint runs pre-commit; gitleaks scans the **full history** in CI. Run it
  locally with `bun run scan:secrets`; config in `.gitleaks.toml`.
- `.env.local` and `.dev.vars` are gitignored and have no other copy — never
  delete them (encrypted backup proposed in
  [secrets-backup-plan.md](secrets-backup-plan.md), not done yet). `.dev.vars` is auto-created from `.dev.vars.example` on the first
  `qa:all` run.

## The session cookie

On https every better-auth cookie is `__Host-better-auth.*` (`authCookieOptions`,
`lib/auth-env.ts`), so a subdomain such as a my-box cannot plant one on lianki.com
(cookie tossing). It does not stop a subdomain's page _sending_ the cookie: that is
`lib/security/same-site-guard.ts`. On http (`next dev`, qa:all) the name stays plain,
because a browser refuses `__Host-` there. `scripts/qa/qa-host-cookie.mjs` runs the
https path.

The change signs everyone out once. `__Secure-better-auth.*` is read by nothing, and
the Worker sends each one back expired (`lib/security/legacy-session-cookies.ts`).
Migration 0051 deletes the old session rows. That code can go once the old cookies
have aged out, 7 days after the change.

## Magic-link email

Sent through **Resend's HTTP API** (`lib/email.ts`), not SMTP. This is a hard
requirement of the Cloudflare migration: nodemailer needs raw TCP, which Workers
does not provide, so an SMTP transport would have failed at cutover — and only
for magic link, the one auth method CI never exercises (the QA suites use the
dev password path).

Needs `RESEND_API_KEY` and `EMAIL_FROM`, and the from-domain must be verified in
Resend. With either missing the magic-link plugin is not registered at all, so
the sign-in form offers OAuth only rather than accepting an address and dropping
the mail.

## Resend webhook (bounces and complaints)

`POST https://lianki.com/api/email/resend-webhook` (`lib/resend-webhook.ts`)
takes Resend's `email.delivered`, `email.bounced` and `email.complained`
events: bounces and complaints suppress the address for invite mail
(docs/payments.md, "Invite by email"), and all three move the mail's row in the
send log (docs/mail-templates.md, "Send log"). Every other event is answered
204 and ignored.

- **Secret**: `RESEND_WEBHOOK_SECRET`, the webhook's signing secret from Resend
  (`whsec_…`), a Worker secret only — no default, nothing in `wrangler.jsonc`,
  read as `process.env.RESEND_WEBHOOK_SECRET`. Unset (or not `whsec_<base64>`):
  the endpoint answers 503 and logs `resend-webhook.no-secret` once per isolate.
- **Signature**: Svix — HMAC-SHA256 over `${svix-id}.${svix-timestamp}.${body}`
  with the key after `whsec_`; `svix-signature` may list several `v1,<base64>`
  (any match passes), checked with WebCrypto `verify` (constant time). A
  timestamp more than 5 minutes off our clock, or any malformed header: 401. A
  delivery id seen in the last 5 minutes (per isolate) is answered
  `{"status":"duplicate"}`; the writes are idempotent anyway.
- **Logs**: event names only (`resend-webhook.bounce`, `.complaint`, `.refused`
  with the reason); never the body or an address.

Setting it up (the main lane, once this endpoint is deployed):

1. Resend → Webhooks → Add endpoint: URL
   `https://lianki.com/api/email/resend-webhook`, events `email.delivered`,
   `email.bounced` and `email.complained` only.
2. Copy the endpoint's signing secret and set it on the Worker:
   `bunx wrangler secret put RESEND_WEBHOOK_SECRET` (it takes effect at once, no
   deploy).
3. Check: Resend's "Send test event" (or any real delivery) shows 2xx in its
   webhook log; a 401 there means the secret is not that endpoint's, a 503
   means it is not set.

**Rotation**: in Resend, roll the endpoint's signing secret, then put the new
value with `wrangler secret put RESEND_WEBHOOK_SECRET`. Deliveries signed with
the old key in between get 401 and Resend retries them, so nothing is lost.
Lost secret: readable again in Resend's webhook page.

## Dev-only password auth

`auth.ts` enables email+password **only** when `NODE_ENV !== production` **and**
`DEV_EMAIL_PASSWORD_AUTH=1`, so it can never be on in the deployed app.
Production is passwordless: email code, magic link, passkeys + GitHub/Google.

## Passkeys

better-auth's passkey plugin (`@better-auth/passkey`, pinned to the
better-auth version), table `passkey` (`db/migrations/0011_passkey.sql`). No
secrets or settings: it is always on.

- **Relying party** is decided in `lib/passkey.ts`, not left to the plugin:
  without a base URL the plugin falls back to `localhost`, which would fail
  every production ceremony. A localhost base URL (qa:all's random port via
  `.dev.vars`, `next dev`) is its own RP on that exact origin; anything else —
  `https://lianki.com` from wrangler.jsonc, or no base URL at all in
  production — is `lianki.com`, with the apex and
  `www` as allowed origins. A passkey made on one RP never works on another,
  so local passkeys and production ones are separate.
- **Sign-in page**: a "Sign in with a passkey" button, plus conditional UI —
  the email field is `autocomplete="username webauthn"` and one autofill
  request starts on page load. After an email (or dev password) sign-in on a
  device with a platform authenticator, a one-time offer to add a passkey;
  "Not now" is remembered in localStorage on that device.
- **Profile page** lists, adds, renames and deletes passkeys. Adding one needs
  a _fresh_ session (better-auth `freshAge`, 1 day since the session was last
  refreshed); otherwise the card asks the user to sign in again.
- QA: `scripts/qa/qa-ui.mjs` drives the whole loop with a CDP virtual
  authenticator.

## Profile edits

`/my/profile` edits the display name and the picture (`lib/profile/`,
`app/(app)/my/profile/ProfileFields.tsx`). Every write is same-origin, for the
session's own user; nothing in a request can name a user.

- **better-auth's HTTP `/update-user` is closed**: `disabledPaths:
["/update-user"]`, because over HTTP it would store any string as a name or
  image. `POST /api/profile/name` and `/api/profile/avatar` validate and then call
  `auth.api.updateUser` server-side, which `disabledPaths` does not touch.
- **Name** (`cleanName`): NFC, control and bidi-override characters out, spaces
  collapsed and trimmed, at most `PROFILE.nameMaxChars` characters.
- **Picture**: the browser crops it to a centred square, shrinks it and re-encodes
  it (WebP, else JPEG; EXIF goes with it). The server takes only JPEG, WebP or PNG
  **by their magic bytes** (`lib/inbox/sniff.ts`; no SVG, no GIF), within
  `PROFILE.avatarMaxBytes`. R2 `lianki-blobs` key: `avatars/<user id>/<random id>`.
  D1 `user_avatar` holds the key, the size and `previousImage` (the provider's
  picture it replaced). A new upload deletes the old object; **Remove** deletes the
  upload and goes back to `previousImage`, or to none. A provider's picture with no
  upload has nothing to remove.
- **Serving**: `GET /api/avatar/<user id>/<random id>` needs no session (the
  picture shows wherever its owner does, such as chat avatars; the id is random).
  Only an allowed stored type is sent, with `nosniff` and a sandbox CSP. A new upload
  is a new URL, so it is `immutable`. `user.image` holds the same-origin path;
  `/api/debug/identity` makes it absolute for the chat hub. `next/image` can't load
  `/api/*` under OpenNext, so the nav passes `unoptimized` for these.
- **Limits** (`lib/profile/config.ts`, D1 `hit()` per user): 20 name changes per
  10 minutes; 10 uploads or removals per hour.
- **Cost**: `chargeInbox` with `what: "avatar"`, log-only as the inbox (upload,
  read, and storage settled when the avatar is replaced or removed).

A picture stays until replaced or removed. There is no account deletion in the
app today; when one comes, it has to delete `avatars/<user id>/` too (the row
cascades, the object does not).

## Changing the email

`lib/profile/email-change.ts`, pen on `/my/profile`. Not better-auth's `/change-email`
(left disabled): it updates the user row alone, with no way to put the moves below
into its transaction, and it applies on a GET, which a mail scanner would trigger.

1. `POST /api/profile/email` (same origin, session under a day old, D1 limits per
   user and per target address). A link goes to the **new** address and a notice,
   with that address masked, to the **old** one. Nothing changes.
2. The link opens `/my/profile/email-confirm#<user id>.<token>`: a fragment, so the
   token reaches no log, and a press on the page is what applies it, so a mail
   scanner changes nothing. D1 `email_change_request` keeps the token's hash, for
   1 hour, one per user: a newer request kills the older link.
3. `POST /api/profile/email/confirm` moves `user.email`, `email_canonical` and every
   table in `EMAIL_KEYED_TABLES` in **one D1 batch**, then tells the old address.
   Failure at any step (a key conflict included) rolls all of it back.

- **Email-keyed data**: `fsrs_notes`, `word_lists`, `word_cards`, `word_list_entries`,
  `word_reviews`, `swipe_log`, `watch_stats`, `study_day`, `roadmap_goals`,
  `api_tokens`, `cli_login`, `dev_access_token`. A unit test fails when a migration
  adds another table with an `email` column. `account_permission` also has one,
  and never moves (see Permission holders). `site_role` has one too and is unused
  (see Permissions). Everything else goes by user id.
- **Taken addresses** (exact or canonical form, or a permission holder's): the same
  answer and the same two mails, but the new address reads "already in use" instead
  of a link.
- **Permission holders**: `account_permission` is read from D1 on every request, not
  from the isolate's snapshot (which fails closed to "nobody", and would let a
  holder's address move). The exact address of anyone holding `admin` or `dev` is
  refused with its reason, since the grant goes by it. A target that is a holder's
  address or its alias gets the "already in use" mail. The batch checks
  `account_permission` again, so a grant landing mid-request still stops it. A
  revoked holder is an ordinary user again.
- **Sessions** stay valid, as with better-auth's flow: they point at the user id.
- **Google/GitHub**: a linked account keeps signing in to this user (matched by
  provider account id first). An unlinked Google account at the old address now
  matches nobody and makes a new account; so does an email code to the old address.
- **Batch size**: on local D1 (`wrangler dev --local`) a 200,000-row account moved in
  0.9 s, and a key conflict on the batch's last table rolled everything back.
  Production D1's limits on one batch were not measured; going over one should fail
  the batch and answer "unavailable", changing nothing. The owner, the largest
  account, is refused anyway.
- **In-flight writes**: a request authenticated just before the batch can still write
  a row under the old address. It would stay behind under that address; the window
  is one request's length.

## Google OAuth

Credentials (`AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`) are shared between
`fsrsnext.snomiao.com` and `lianki.com`. Both domains must be in the Google Cloud
Console OAuth client:

- `https://lianki.com/api/auth/callback/google` (canonical)
- `https://www.lianki.com/api/auth/callback/google` (keep registered — www still
  resolves and 308s to apex)

## Google Drive connection

Separate from sign-in, same OAuth client: its own flow and table
([connections.md](connections.md)). Needs a second redirect URI on the client,
`https://lianki.com/api/connections/google/callback`, and the Worker secret
`GOOGLE_PICKER_API_KEY` (a browser key restricted to lianki.com and the
Picker API). Refresh tokens are sealed with a key derived from `AUTH_SECRET`
(HKDF), so no other secret.

## Origins

The apex is canonical: `middleware.ts` 308s `www` → apex, and session cookies
bind to the exact hostname the user signed in on. The userscript rewrites an old
`www` `@downloadURL` to the apex so pre-2.23.18 installs keep working without a
reinstall.

## Live progress token (`PROGRESS_TOKEN`)

A secret on the **lianki-push** Worker (not the main one): the root token for
the live state tree ([state-tree.md](state-tree.md), "Live progress"). Agents
write with it or with a scoped token minted from it
(`bun scripts/dev/progress.ts grant …`). Set it once:

```bash
openssl rand -base64 32 | tr -d '\n' | bunx wrangler secret put PROGRESS_TOKEN -c workers/push/wrangler.jsonc
```

Keep the same value as `PROGRESS_TOKEN=…` in `.dev.vars` (or export
`LIANKI_PROGRESS_TOKEN`) where the CLI runs. Unset, every write answers 503 and
the owner's tree shows the hand-edited outline only. Rotating it invalidates
every scoped token at once.

## Permissions (`admin`, `dev`)

**Every owner/dev/admin gate is a permission check** (owner's standing rule,
2026-11-09): `isAdmin(email)` or `isDev(email)` from `lib/permissions.ts`, never
an email list in code or env. The grants are rows in D1, table
`account_permission` (`db/migrations/0058_account_permission.sql`,
`lib/account-permission.ts`), one row per address and permission, revocable,
managed at **`/dev/permissions`** (admin only, 404 otherwise). Every grant and
revoke goes through an in-app confirm dialog and writes `permission.grant` /
`permission.revoke` to `security_audit` (detail: `<permission> <address>`).
Granting a permission the address already holds changes nothing in
`account_permission` (the original `granted_by` / `granted_at` stay) and is
recorded only as `permission.regrant`. The page's **History** section lists
these rows newest first, 50 a page, with the time in JST, the actor's address
(or `cli`) and the source (`/api/dev/permissions/history`,
`readPermissionHistory`).

- **`admin`** — people, money and grants: `/dev/permissions`, users, credits, membership, gift codes, friends, flags, box clients, and the
  payment test mode.
- **`dev`** — every other `/dev` page and `/api/dev` route, the dev bridge, live
  view, the whole-page dev server and its tunnel gate, the owner chat thread (chat
  log, inbox agent, lane chat tokens, `box:chat`), `eval` (eval tokens, `box:eval`,
  debug-session renewal), the pill chat and partner ticket, the my-box allowlist,
  and features shipped dark (`libraryOn(flags, isDev(…))`, YouTube songs). The
  Learning Partner AI refuses a `dev` holder (his thread is the dev lanes').
- The "owner chat thread" is the **dispatch thread** (`DISPATCH_THREAD` in
  `lib/dev-eval.ts`): every `dev` holder's pages and chat tokens join it
  (`threadFor`). No path checks the owner's address; the inventory is
  [owner-paths-audit-2026-11-15.md](owner-paths-audit-2026-11-15.md).
- Neither implies the other; each is its own grant. Which permission a `/dev`
  page checks is listed in `lib/dev-page-permissions.ts` (a unit test keeps it
  in step with the pages), and the `/dev` layout prints a small "who can see
  this page" line under each page for viewers who hold that permission.
- **Exact address.** Lowercased and trimmed, never the canonical form
  (`lib/canonical-email.ts`): `someone+admin@gmail.com`, `someone@gmail.com` and
  `some.one@gmail.com` are three people here. A grant reads no user table.
- **How checks read it.** `isAdmin`/`isDev` are synchronous and answer from a
  snapshot in the isolate, refreshed by `auth.api.getSession` (`auth.ts` →
  `lib/permission-store.ts`) before it hands back a signed-in user. D1 is read once
  the snapshot is 20 s old; one 30 s old counts for nothing, so a revocation holds
  everywhere within **30 s**. Code without a session refreshes for itself (the
  payment webhooks, the bearer-token path of `/api/debug/partner-ticket`, the pill
  chat). Checks that must be live read D1 directly with the helpers in
  `lib/account-permission.ts` (`readHolders`, `holderIds`, `userHolds`, `holdsSql`):
  the `DebugSessions` RPCs, chat and eval tokens, the box allowlist, email change.
- **Fail closed.** A D1 error, a missing table, or another backend than D1 means
  nobody holds anything for that call: a 404, not a crash, logged as
  `permissions.read-failed`. A local Mongo `next dev` has no `/dev`.
- **"The owner", where only one account can be meant** (the dev bridge, the
  whole-page dev server's sign-in): the oldest active `dev` grant.
- **On a box** (docs/box-oauth.md): `/api/box/me` reports `isAdmin` and `isDev`
  for the signed-in account, and the box's own server puts exactly those into
  its snapshot, never its local D1. An answer without them grants nothing.
- **Last admin.** The only active `admin` cannot be revoked (guard inside the
  `UPDATE`). To replace him, grant the new one first.
- **No seed.** The migration inserts nobody: grants are added as data after the
  owner approves them (a tap card), with the break-glass CLI:

```bash
bun scripts/dev/permission.ts list
bun scripts/dev/permission.ts grant someone@example.com admin,dev
bun scripts/dev/permission.ts revoke someone@example.com dev   # --local for the local D1
```

**Migration off `site_role` (2026-11-09), lockout-safe — done:**
(a) shipped the table, the helpers, `/dev/permissions` and every call site on
`isAdmin`/`isDev`, while an active `site_role` owner still passed both checks;
(b) the owner approved, and both of his accounts were granted `admin` and `dev`
with the CLI above (13:30 JST); (c) the fallback, `lib/owner.ts`,
`lib/owner-store.ts`, `lib/site-role*.ts`, `/dev/owners`,
`scripts/dev/owner-role*.ts` and every direct `site_role` query were removed.

**`site_role` is unused.** The table (migration 0047) is still in D1 with its
rows, and nothing reads or writes it; its old audit kinds `site-role.grant` /
`site-role.revoke` stay readable in `security_audit`. Dropping it is a data
delete, so it waits for the owner's tap card and its own migration. Never add a
check against it, against `OWNER_EMAILS`, or against any email in code.

Cloudflare Access (`scripts/ops/cloudflare-access.ts`, prepared, not applied)
keeps its own allowlist, given with `--email`; it does not follow the grants.

## Dev bridge (`DEV_BRIDGE_SECRET`)

A Worker secret on `lianki`, used for one thing only. The owner's whole-page
dev server (docs/dev-whole-page.md) signs its sessions with a local secret,
so lianki.com can't read them, and the debug chat hub (lianki-push) refused
that page. The dev server's guard sends this secret in `x-lianki-dev-bridge`,
lianki-push passes it on, and `/api/debug/identity` answers with the **owner**
(the oldest active `dev` grant), never anyone else, when it matches
(`lib/dev-bridge.ts`).

Since 2026-10-31 02:11 JST (the owner typed "1同意"), the same header also
works on `/api/words/tts` and `/api/debug/stt`, as the owner, so the dev page
can read words aloud and transcribe without Workers AI credentials on the
Mac. Since 2026-10-31 (owner, decision D in docs/prefs-sync.md) it also
works on `/api/prefs`, read and write, so the dev page and lianki.com share
his settings. Since 2026-11-14 21:48 JST (owner, "走 A") it also works on
`/api/my/recordings` (list, clip, day archive, upload, delete), so his preview
server shows his recordings without a copy of `AUTH_SECRET`: the preview
forwards that route here and lianki.com decrypts (docs/recordings.md, "On the
preview"). These are the only routes that accept it as the owner
(`lib/dev-bridge-user.ts`). Separately, since 2026-11-01 it is what the dev
server's tunnel gate proves itself with on `POST /api/dev-access/verify`,
which checks a dev access token and answers nothing else (no owner session
is made there); without the header that route answers 401.

- A wrong value gets 401, with no fall back to the cookie.
- Unset, or shorter than 32 characters, the bridge is shut.
- `AUTH_SECRET` is never shared. The owner chose this over copying it to the
  Mac on 2026-10-31.

The only other copy is `.dev-whole-page.json` (gitignored, 0600) in the dev
server's worktree. To rotate it, generate a new value there and
`wrangler secret put DEV_BRIDGE_SECRET` from the file, never by echoing it.

## Live view key (no secret on the Worker)

Live view ([live-view.md](live-view.md)) is the reverse of the STT tickets
below: the owner's Mac signs and lianki.com verifies. The Ed25519 **private**
key is `~/.config/lianki/live-view-key.json` (0600) on the Mac only, made by
`bun scripts/dev/live-view.ts keygen`. The **public** key is committed in
`lib/live-view/keys.ts`, so the Worker and the browser bundle trust the same
key, and a change to it is a reviewed diff. There is no Worker var and no
secret. `NEXT_PUBLIC_LIVE_VIEW_TEST_KEY` adds a test key in dev builds only;
a production build ignores it. Rotate: keygen a new pair (move the old file
away first), add the new key to `LIVE_VIEW_PUBLIC_KEYS`, deploy, then drop the
old key.

## Live pages (`LIVE_GATE_SECRET`)

A Worker secret on `lianki` (2026-11-05): the main Worker's way through the
gate in front of the owner's dev server for the same-origin live preview
([live-view.md](live-view.md), "Same-origin pages"). The Worker sends it in
`x-lk-live-gate` to the pointer's page origin, only after it has checked the
owner's session and the signed pointer; the gate compares it in constant
time (32+ characters, or that entry is shut), counts failures per IP, and
strips it before anything reaches next dev. It also keys the HMAC of the
`__Host-lk_live` cookie, the owner's and, under its own label, a custom
frontend's ([custom-frontend.md](custom-frontend.md)), which never send it
anywhere. Unset: every `?live=` gets the production page.

The only other copy is `liveSecret` in `.dev-whole-page.json` (gitignored, 0600) in the dev server's worktree. Set or rotate it (a secret: the owner's
tap first), never by echoing it:

```bash
cd ~/ws/snolab/lianki/tree/preview-serve
bun scripts/dev/whole-page.ts live-secret   # makes liveSecret if missing; pipes it to wrangler secret put
# then restart serve so the gate reads it
```

To rotate, delete `liveSecret` from the file first (the next run makes a new
one). Live cookies sealed with the old value stop working at once.

## STT tickets (`STT_TICKET_KEY`)

A Worker secret on `lianki`: an Ed25519 **private** key (a JWK) that signs
the tickets for the owner's local STT server over the public tunnel
(`wss://stt.lianki.com`; [local-stt.md](local-stt.md), "Off the tailnet").
`POST /api/dev/stt-ticket` answers the owner's session only (`isDev`, 404
for anyone else; 503 while the secret is unset) with a ticket good for 60 s
and one connection (`aud` `lianki-stt`, a random `jti`). The Mac holds only
the **public** key (`~/.config/lianki-stt/ticket.pub`), so nothing on the Mac
can mint a ticket, and no secret is shared: `AUTH_SECRET` and
`DEV_BRIDGE_SECRET` are not involved.

Set or rotate it (a production secret: the owner's OK first). The script
writes the public key file and hands the private key only to the pipe; it
refuses to print it to a terminal, and no other copy is kept:

```bash
bun scripts/local-stt/ticket-key.ts | bunx wrangler secret put STT_TICKET_KEY
oxmgr restart lianki-stt   # the server reads the new public key
```

Rotating kills every outstanding ticket at once (they live 60 s anyway).

The same key signs the **voiceprint tickets** (`aud` `lianki-voiceprint`,
`POST /api/dev/voiceprint-ticket`; enrol and delete only after the owner's
passkey with user verification; [local-stt.md](local-stt.md), "Voiceprint:
who may enrol and delete"). Without `ticket.pub` on the Mac, every
voiceprint op is refused. lianki.com checks the same tickets itself before
it writes or deletes the voiceprint features kept in an account
(`/api/my/voiceprint`; passkey tickets carry the account's `uid`). Those
features are sealed with a key derived (HKDF) from **`AUTH_SECRET`**, info
`lianki/voiceprint/features-at-rest/v1`: no secret of their own
([local-stt.md](local-stt.md), "Voiceprint in your account").

## Speaker attestation key (`STT_SPEAKER_PUB`)

A Worker secret on `lianki-push` (the hub): the **public** half of the Mac's
Ed25519 key that signs each final's speaker tag
(`~/.config/lianki-stt/speaker-attest.key`, 0600, on the Mac only). The hub
keeps a speaker tag on a voice line only when its signature verifies
(`lib/speaker-proof.ts`); without the secret no tag is kept. Set it (the
owner's OK first):

```bash
~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/voiceprint.py attest-key \
  | bunx wrangler secret put STT_SPEAKER_PUB -c workers/push/wrangler.jsonc
oxmgr restart lianki-stt   # the server loads the key and signs from then on
```

The cloudflared tunnel's own credentials (`~/.cloudflared/<uuid>.json`,
`cert.pem`) are separate: mode 0600, on the Mac only, never committed;
whoever holds the credentials file can run a connector for the tunnel.

## Dev access tokens (the dev server's tunnel)

Keys to the owner's whole-page dev server at `https://preview.lianki.com`
(docs/dev-whole-page.md, "Off the tailnet"). Minted on `lianki.com/dev/tokens`
by the owner's session only, shown once, stored as a SHA-256 in D1
(`dev_access_token`); the profile menu mints single-use 60 s handoffs
instead. No new Worker secret: the gate verifies through
`/api/dev-access/verify` with `DEV_BRIDGE_SECRET`. A token signs in only as
the owner who minted it; revoking it ends its dev-server sessions within
30 s. It is never logged and never left in a URL (form POST, or a `#`
fragment stripped at once; a token in a query string is refused).

On the Mac (all mode 0600, never committed): `~/.config/lianki/cf-api-token`
(the Cloudflare API token for `scripts/ops/cf-tunnel.ts`: Account ·
Cloudflare Tunnel · Edit, Zone · DNS · Edit, Zone · Zone WAF · Edit, Zone ·
Zone · Read), `~/.config/lianki/preview-tunnel-token` (the tunnel's run
token, from the API, for `cloudflared --token-file`), and `previewKey` in
`.dev-whole-page.json` (seals the gate's session cookie; delete it to end
every tunnel session).

## Box tokens (no new secret)

A my-box signs in through lianki.com with OAuth and PKCE
([box-oauth.md](box-oauth.md)). No secret is added: the client is public, tokens
are stored hashed by better-auth's plugin, and the one-minute identity the
Worker's gate hands the app is signed with a key derived from `AUTH_SECRET`.
Nothing of this is in a box.

## API tokens (`lk_…`): fine-grained, one account, expiring

Owner decision 2026-11-07: tokens work like GitHub's fine-grained personal
access tokens. One system (`api_tokens`, `lib/api-tokens.ts`,
`db/migrations/0056_api_token_scopes.sql`) for the userscript's, `lianki auth
login`'s and the agent lanes' tokens.

- **One account.** `user_id` (and the email) are fixed when the token is made
  and joined to the live `user` row on every use. A token acts only as that
  account, never another, and dies with it. A sign-out everywhere
  (better-auth `/revoke-sessions`, or `/delete-user` if ever enabled) deletes
  every token of the account (`lib/api-token-signout.ts`).
- **Permissions as data** (`SCOPES`): `study` (cards, reviews, settings: what
  every token could do before), `chat:read`, `chat:write`, `chat:ask`, and
  `eval` for a site owner only ("Eval tokens", below). Chosen at creation; a
  route asks for one. `pair`, `grant`, `admin`, `answer` are not permissions
  at all (`FORBIDDEN_SCOPES`): a request naming one is refused. Card and settings routes (`authEmailOrToken`,
  `apiTokenUser`) need `study`, so a chat-only lane token reaches none of them.
  The other way round, `study` never reaches the chat: the Learning Partner
  ticket (`/api/debug/partner-ticket`, `lib/partner-ticket-auth.ts`) takes a
  token only with `chat:read` and `chat:write`, and only the owner's (the
  ticket opens the owner's thread, chat only). No other `/api/debug/*` or
  `/api/dev*` route takes a token.
- **Required expiry**: 7, 30, 90 or 365 days, or a date, at most 366 days. No
  default. Rows from before 0056 read as `study` with no expiry (shown so).
- **Last used** (written at most once a minute), shown on the page.
- **Secret once.** Only the SHA-256 is stored; the page shows the secret once.
  Ids, the audit log and hub sockets carry the hash (or its first 16 hex, the
  `tag`), never the token. No token in a URL: `DELETE /api/token` takes
  `{id}` in the body.
- **Page**: Settings (`/my/preferences`) → API tokens
  (`app/(app)/my/preferences/TokenManager.tsx`, strings in
  `app/components/api-tokens.content.ts`): the owning account, each token's
  name, permissions, created, expiry, last used, and Revoke behind an inline confirm (RevokeConfirm.tsx; Esc or Cancel backs out); the
  form takes name, permissions and expiry. `/api/token` (`lib/api-token-api.ts`)
  takes a browser session only; a token can never make or list tokens.
- **Instructions for the user's AI assistant**: every token row (and the new
  token's box) offers a copyable prompt built from the token's permissions, in
  the page's language, never containing the secret; also public at
  `GET /api/agent-guide` ([api-for-agents.md](api-for-agents.md)).
- **Audit** (`security_audit`): `api-token.create`, `.revoke`, `.revoke-all`,
  `.use` (when last used is written), `.refused` (a known token expired, out
  of scope or over its rate limit; at most 5 per 10 min per token).
- **Chat**: `lianki chat` ([lianki-dev-cli.md](lianki-dev-cli.md), "lianki chat").

### Eval tokens (`eval`): code on the owner's pages, no tap

Owner's decision by tap card, 2026-11-07 ("这样做"). **The trust boundary, in
plain words: whoever holds an eval token can run any code on the owner's open
pages, lianki.com and his box, with no pairing tap. Making the token is the
grant.** A leaked token means arbitrary code on his signed-in pages until it is
revoked or expires. He accepted that risk.

- **Only a `dev` holder can make one.** `eval` is in `OWNER_SCOPES`
  (`lib/api-tokens.ts`). Settings → API tokens offers it only when the session's
  account holds `dev` (`account_permission`, read from D1 at that moment). Anyone else
  never sees it, and a request naming it gets the same 400 as an unknown
  permission. The CLI login (`lianki auth login`) never offers or accepts it.
- **At most 30 days** (`EVAL_MAX_DAYS`). The expiry is required as for every
  token. A row from before expiry dates is never an eval token.
- **Shown once, stored hashed, bound to his account.** This works as for every
  token: one click on the page revokes it, and a sign-out everywhere deletes it.
- **Checked at every use** (`lib/eval-token.ts`, `DebugSessions.evalToken` over
  the SESSIONS binding):
  - when a sender connects with it (`Authorization: Bearer lk_…` on
    `/api/version/debug/control`, which lianki-push turns into an internal
    header, refusing any copy a client sends);
  - again before every eval it sends.

  Each time it checks that the token is live, holds `eval`, and that its
  account is a site owner now. Up to 300 uses per 10 minutes per token.

- **Every use is audited.** Each connect and each eval writes an
  `api-token.eval` row to `security_audit`: the token's tag, its name, the
  code's length and the target, never the code or the token. A refused use is
  `api-token.refused`.
- **What it reaches.** The owner's thread, as an eval session (code and chat)
  until the token expires. It reaches every owner page without a tap. A box page
  is reached only while that box holds `box:eval` (box-oauth.md, "Code on the
  owner's box"); the box keeps its own per-use checks. It never reaches a
  friend's pages and never opens a friend's preview. A revoke notice
  (`/internal/chat-tokens/revoked`) closes its sender at once; the per-use check
  catches one the notice missed. "End" on a page closes that sender's socket but
  does not revoke the token: Revoke on the token page does.
- **Use**: `LIANKI_TOKEN=lk_… bun scripts/dev/eval.ts --target box '<code>'`, or
  `lianki-dev serve` with LIANKI_TOKEN set. Without a token, or with a lane's
  chat-only token (refused for eval), `eval.ts` uses the saved grant and the
  pairing flow exactly as before.

## CLI login (`lianki auth`, API tokens)

`lianki auth login` (the npm package `lianki`, `packages/lianki-cli`; run it
with `bunx lianki` or `npx lianki`) signs the command-line tool in to an
account; `lianki settings list | get <key> | set <key> <value>` then reads and
writes that account's synced settings ([prefs-sync.md](prefs-sync.md)) through
`/api/prefs`, which checks every value against `lib/prefs/schema.ts`.
Code: `packages/lianki-cli/cli.mjs` (commands), `packages/lianki-cli/auth.mjs`
(Keychain, browser, loopback listener), `lib/cli-login.ts` (server logic), `/cli-login` (page),
`/api/cli-login/approve`, `/api/cli-login/token`, table `cli_login`
(`db/migrations/0028_cli_login.sql`). No secret or Worker variable is involved.

The browser flow (default), a loopback flow with a one-time code and PKCE:

1. The CLI picks a random verifier, state and port, listens on
   `127.0.0.1:<port>`, and opens
   `/cli-login?redirect_uri=http://127.0.0.1:<port>/cb&state=…&code_challenge=…&code_challenge_method=S256&host=<hostname>`.
2. The page needs a signed-in user (owner or anyone), checks every parameter
   (the redirect only `http://127.0.0.1:<port>/cb` or `http://[::1]:<port>/cb`),
   and shows what Approve creates: an API token named `lianki CLI <hostname>`
   for that account, and where the code goes. The user ticks its permissions
   and picks its expiry there (see "API tokens" below; neither has a default,
   and Approve refuses without both). Deny tells the CLI and creates nothing.
3. Approve (same-origin JSON, the page's request id, the state, the permissions
   and the expiry) turns the
   request into a one-time code (60 s) and the page goes to
   `http://127.0.0.1:<port>/cb?code=…&state=…`.
4. The CLI checks the state, then POSTs the code, the verifier and the
   redirect to `/api/cli-login/token` (10 per IP per 15 min) and gets the token
   in the body.

Paste mode: `lianki auth login --token -` reads a token made in Settings → API
tokens from stdin (`--token lk_…` and `LIANKI_TOKEN=lk_…` work too, but leave
it in the shell's history). `LIANKI_TOKEN`, when set, is used instead of the
stored token; `LIANKI_URL` points the CLI at another site.

Where the token lives: the macOS Keychain (service `lianki-cli`, account =
the site's host), written through `security -i` on stdin; elsewhere, or if the
Keychain refuses, `~/.config/lianki/cli.json` (0600, folder 0700), which
otherwise holds only the account, the token's name and the CLI's device id.
The CLI never prints the token. `lianki auth status` says who and whether the
server still accepts it; `lianki auth logout` revokes it on the server
(`DELETE /api/cli-login/token` with the token itself, which can delete only
itself) and forgets it. `GET /api/cli-login/token` with the token answers
its own name, permissions and expiry (read-only; `lianki mcp` uses it).

Only `/api/prefs` accepts the token as `Authorization: Bearer` this way
(`lib/api-token-user.ts`, D1 only; a bad token is 401, never a fall back to
the cookie). The card commands (`next`, `review`, `due`, `add`, …) use the
older `authEmailOrToken` path on `/api/fsrs/*`, which looks the token up in D1
too (`lib/apiTokenAuth.ts`). `/api/export/yaml` and `/api/import/yaml` take
the session cookie only, which is why the 0.2 CLI dropped `export`/`import`.
