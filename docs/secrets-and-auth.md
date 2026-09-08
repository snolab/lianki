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
Production is passwordless: magic link + GitHub/Google.

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
