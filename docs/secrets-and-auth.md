# Secrets and auth

## Secret hygiene

- secretlint runs pre-commit; gitleaks scans the **full history** in CI. Run it
  locally with `bun run scan:secrets`; config in `.gitleaks.toml`.
- `.env.local` and `.dev.vars` are gitignored and have no other copy — never
  delete them (encrypted backup proposed in
  [secrets-backup-plan.md](secrets-backup-plan.md), not done yet). `.dev.vars` is auto-created from `.dev.vars.example` on the first
  `qa:all` run.

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

## Google OAuth

Credentials (`AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`) are shared between
`fsrsnext.snomiao.com` and `lianki.com`. Both domains must be in the Google Cloud
Console OAuth client:

- `https://lianki.com/api/auth/callback/google` (canonical)
- `https://www.lianki.com/api/auth/callback/google` (keep registered — www still
  resolves and 308s to apex)

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

## Dev bridge (`DEV_BRIDGE_SECRET`)

A Worker secret on `lianki`, used for one thing only. The owner's whole-page
dev server (docs/dev-whole-page.md) signs its sessions with a local secret,
so lianki.com can't read them, and the debug chat hub (lianki-push) refused
that page. The dev server's guard sends this secret in `x-lianki-dev-bridge`,
lianki-push passes it on, and `/api/debug/identity` answers with the **owner**
(the first `OWNER_EMAILS` account), never anyone else, when it matches
(`lib/dev-bridge.ts`).

Since 2026-10-31 02:11 JST (the owner typed "1同意"), the same header also
works on `/api/words/tts` and `/api/debug/stt`, as the owner, so the dev page
can read words aloud and transcribe without Workers AI credentials on the
Mac. Since 2026-10-31 (owner, decision D in docs/prefs-sync.md) it also
works on `/api/prefs`, read and write, so the dev page and lianki.com share
his settings. These are the only routes that accept it
(`lib/dev-bridge-user.ts`).

- A wrong value gets 401, with no fall back to the cookie.
- Unset, or shorter than 32 characters, the bridge is shut.
- `AUTH_SECRET` is never shared. The owner chose this over copying it to the
  Mac on 2026-10-31.

The only other copy is `.dev-whole-page.json` (gitignored, 0600) in the dev
server's worktree. To rotate it, generate a new value there and
`wrangler secret put DEV_BRIDGE_SECRET` from the file, never by echoing it.

## STT tickets (`STT_TICKET_KEY`)

A Worker secret on `lianki`: an Ed25519 **private** key (a JWK) that signs
the tickets for the owner's local STT server over the public tunnel
(`wss://stt.lianki.com`; [local-stt.md](local-stt.md), "Off the tailnet").
`POST /api/dev/stt-ticket` answers the owner's session only (`isOwner`, 404
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
The cloudflared tunnel's own credentials (`~/.cloudflared/<uuid>.json`,
`cert.pem`) are separate: mode 0600, on the Mac only, never committed;
whoever holds the credentials file can run a connector for the tunnel.

## CLI login (`lianki auth`, API tokens)

`bun run lianki auth login` signs the command-line tool in to an account;
`bun run lianki settings list | get <key> | set <key> <value>` then reads and
writes that account's synced settings ([prefs-sync.md](prefs-sync.md)) through
`/api/prefs`, checked against `lib/prefs/schema.ts` before anything is sent.
Code: `scripts/dev/lianki-auth.ts` (commands), `scripts/dev/lianki-io.ts`
(Keychain, browser), `lib/cli-login.ts` (server logic), `/cli-login` (page),
`/api/cli-login/approve`, `/api/cli-login/token`, table `cli_login`
(`db/migrations/0023_cli_login.sql`). No secret or Worker variable is involved.

The browser flow (default), a loopback flow with a one-time code and PKCE:

1. The CLI picks a random verifier, state and port, listens on
   `127.0.0.1:<port>`, and opens
   `/cli-login?redirect_uri=http://127.0.0.1:<port>/cb&state=…&code_challenge=…&code_challenge_method=S256&host=<hostname>`.
2. The page needs a signed-in user (owner or anyone), checks every parameter
   (the redirect only `http://127.0.0.1:<port>/cb` or `http://[::1]:<port>/cb`),
   and shows what Approve creates: an API token named `lianki CLI <hostname>`
   for that account, and where the code goes. Deny tells the CLI and creates
   nothing.
3. Approve (same-origin JSON, the page's request id and the state) turns the
   request into a one-time code (60 s) and the page goes to
   `http://127.0.0.1:<port>/cb?code=…&state=…`.
4. The CLI checks the state, then POSTs the code, the verifier and the
   redirect to `/api/cli-login/token` (10 per IP per 15 min) and gets the token
   in the body.

Paste mode: `lianki auth login --token -` reads a token made on the profile
page from stdin (`--token lk_…` and `LIANKI_TOKEN=lk_…` work too, but leave
it in the shell's history). `LIANKI_TOKEN`, when set, is used instead of the
stored token; `LIANKI_URL` points the CLI at another site.

Where the token lives: the macOS Keychain (service `lianki-cli`, account =
the site's host), written through `security -i` on stdin; elsewhere, or if the
Keychain refuses, `~/.config/lianki/cli.json` (0600, folder 0700), which
otherwise holds only the account, the token's name and the CLI's device id.
The CLI never prints the token. `lianki auth status` says who and whether the
server still accepts it; `lianki auth logout` revokes it on the server
(`DELETE /api/cli-login/token` with the token itself, which can delete only
itself) and forgets it.

Only `/api/prefs` accepts the token as `Authorization: Bearer` this way
(`lib/api-token-user.ts`, D1 only; a bad token is 401, never a fall back to
the cookie). The older `authEmailOrToken` routes are unchanged; note that its
token lookup reads the Mongo copy, so on D1 it does not find new tokens.
