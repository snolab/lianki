# Secrets and auth

## Secret hygiene

- secretlint runs pre-commit; gitleaks scans the **full history** in CI. Run it
  locally with `bun run scan:secrets`; config in `.gitleaks.toml`.
- `.env.local` and `.dev.vars` are gitignored and unrecoverable — never delete
  them. `.dev.vars` is auto-created from `.dev.vars.example` on the first
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
