# Mail templates: one store for every transactional mail

Owner request 2026-11-09. Every mail Lianki sends renders through one template
store (`lib/mail-templates/`), so an edit at **/dev/templates** changes the real
mail. Code: `defs.ts` (the templates), `engine.ts` (validate + render),
`store.ts` (D1), `compose.ts` (send-time render with fail-safe),
`locales.ts` / `recipient-locale.ts` (language), `brand.ts` (product name).

## The templates and their locked variables

A template's REQUIRED variables are locked: a save without them in both the
HTML and the text is refused, and a link variable must be a link in the HTML
(`href="{url}"`). Optional variables may be dropped. Unknown variables are
refused. `{brand}` and `{brandLong}` are available in every template.

| id                | sent when                                    | locked                                                                 | optional                                                                    |
| ----------------- | -------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `signin-code`     | email OTP sign-in (auth-impl.ts)             | `{code}`                                                               |                                                                             |
| `signin-link`     | magic-link sign-in (auth-impl.ts)            | `{url}`                                                                |                                                                             |
| `login-notice`    | sign-in from a new browser (security plugin) | `{time}` `{location}` `{browser}` `{contactUrl}` (not you)             |                                                                             |
| `email-confirm`   | email change: to the new address             | `{url}`                                                                |                                                                             |
| `email-taken`     | email change: the new address is taken       | —                                                                      |                                                                             |
| `email-requested` | email change: to the current address         | `{address}` `{contactUrl}`                                             |                                                                             |
| `email-changed`   | email change done: to the old address        | `{address}` `{contactUrl}`                                             |                                                                             |
| `invite`          | invite a friend by email                     | `{inviter}` `{address}` `{inviteUrl}` `{unsubscribeUrl}` `{reportUrl}` | `{extraDays}` `{baseDays}` `{totalDays}` `{site}` `{contactUrl}` `{postal}` |

There is no email-verification, password-reset or passkey mail: better-auth
sends none in this app (password auth is dev-only and has no reset mail; the
passkey plugin mails nothing). A new mail gets a template here first.

The invite's List-Unsubscribe headers are code, not template.

## Languages

17 variants per template: the app's 16 locales plus `zh-Hant`. `zh` is
Simplified (zh, zh-CN, zh-SG, zh-Hans); `zh-Hant` is Traditional (zh-TW,
zh-HK, zh-MO). Built-in strings are intlayer content files, each key with its
context line (docs/i18n.md): `sign-in-mail.content.ts`,
`login-notice-mail.content.ts`, `email-change-mail.content.ts`,
`lib/referrals/invite-mail.content.ts`. intlayer has one Chinese, so the
Traditional strings are in `zh-hant.ts`, keyed like those dictionaries (a
missing key is a type error).

Recipient language: the account's `ui.locale` → its `signupLocale` → the
request's language (sign-in and email-change only, where the request comes from
the recipient) → `en`. Invites use the inviter's account. A bare `zh` says no
script, so a later Traditional source (`signupLocale` zh-Hant, Accept-Language
zh-TW) makes it `zh-Hant`.

## Brand

Mails never spell the product name: `{brand}` / `{brandLong}`, filled from
`brand.ts` at every send, stored edits included. Chinese says 炼記 today
(owner decision pending); change `MAIL_BRAND_ZH` and every mail follows.

## Store (D1, db/migrations/0064_mail_templates.sql)

- `mail_template_version`: append-only (triggers refuse UPDATE/DELETE). One
  row per save: template, locale, version (1, 2, …), schema, subject, html,
  text, note, who, when.
- `mail_template_active`: which version a template sends per language; none or
  0 = the built-in default. Save makes the new version active; **rollback** =
  activate an older version (or 0).
- `schema` is the template's variable-set version (`defs.ts`). Change a
  template's variables → bump it; older edits stop applying.

## Safety

- HTML: allow-listed tags and attributes only; no script/style/iframe/form/svg,
  no `on*`, links https/http/mailto or a link variable, images https only,
  inline styles without url()/expression()/escapes, no comments. Refused, not
  stripped: what is saved is what is sent.
- Values are HTML-escaped in the HTML part; link values must be http(s).
- **Fail-safe**: at send time a stored edit that cannot be read, has an old
  schema, or fails to validate or render is skipped and the built-in default
  goes out. Logged as `mail.template.fallback` with template, locale, version
  and reason — never an address. A sign-in mail is never blocked by a template.

## Editor: /dev/templates (isDev)

`app/(app)/dev/templates`, API `app/api/dev/templates` → `lib/mail-templates/route.ts`.

- Pick a template, a language (17) and a sample-data set (typical / long
  values); the editor (subject, HTML, plain text) sits beside a **live
  preview** (side by side on a desktop, stacked on a phone). The preview runs
  the same engine as a send, in the browser, inside a sandboxed iframe (no
  script, no same-origin); a Light/Dark switch imitates a mail app's theme.
- Locked and optional variables are listed above the fields; problems show
  under them as you type, and Save stays off until there are none. The server
  validates again.
- **Save** appends a version and makes it the one sent. The version list shows
  every saved version plus the built-in, with **Diff** (that version → the
  editor, line diff with HTML split at closing tags), **Edit from this**, and
  **Roll back to this** / **Send the built-in**.
- **Send test to me** renders the editor's source with the sample data and
  sends it to the signed-in developer's own address only (never one from the
  request), subject prefixed `[test]`; 5 per 10 minutes per developer; a stub
  on a local server (`isLocalOrigin`). Save, rollback and test sends are in
  `security_audit` (`mail-template.save` / `.activate` / `.test-send`, subject
  `<template>:<locale>`).
- QA: `scripts/qa/qa-templates.mjs` (suite `templates`): desktop + phone,
  light + dark, edit → preview → unsafe HTML refused → save → test send →
  diff → rollback.

## Send log: /dev/mails (isDev)

Owner request 2026-11-09. Every outgoing mail gets one row in D1
`mail_log` (`db/migrations/0066_mail_log.sql`), written in the one send path:
`lib/mail-log/send.ts` `withMailLog` wraps the provider call (Resend, or the
local stub). Production wiring is `lib/mail-log/deliver.ts` (`sendMail`,
`localOrSend`); the login notice wraps its own D1 the same way
(`lib/security/auth-plugin.ts`). Callers pass `log` on the send input —
`composeMail` returns it (template, version, locale, kept variables) and the
caller adds the user / inviter ids. `log` is never sent to the provider.

- **Row**: time, template id + version (0 = built-in, -1 = an editor test
  send), locale, **recipient address**, its hash (matches
  `invite_email_suppression`), user id / inviter id / invite log id when
  known, status, a short reason, Resend's message id, and `resend_of`.
- **Status**: `queued` before the call → `sent` (message id) or `failed`
  (short reason, anything shaped like an address cut out). Then, forward only,
  from Resend's webhook: `delivered` (`email.delivered`), `bounced` (hard
  bounce), `complained` (`email.complained`); from the invite opt-out:
  `unsubscribed` (Unsubscribe) or `complained` (Report abuse). A late
  "delivered" never undoes a complaint; a failed mail stays failed. The row
  is found by the `mail_log` tag every mail carries, else by the message id.
- **The address** (owner decision): stored; read only at /dev/mails and
  `/api/dev/mails` (isDev); never written to a log line; deleted with the
  account (trigger on `user`: rows to its address, about it, or that it sent
  as invites). Invite rows from before the log are copied masked
  (`f***@example.com`, `recipient_masked` = 1) — no address backfill.
- **Variables**: only the allow-list in `lib/mail-log/vars.ts`
  (`STORED_VARS`) is kept, filtered again inside the logger whatever a caller
  passes. Never a sign-in code, a sign-in or confirm link, an invite link or
  an opt-out token. The detail view re-renders the mail from template id +
  version + kept variables; anything not kept shows as `{name}` or
  `https://placeholder.invalid/<name>`.

The page (`app/(app)/dev/mails`, API `app/api/dev/mails` →
`lib/mail-log/route.ts`): the list newest first, 50 a page; filters
(template, status, language, JST date range); search by part of an address or
a whole message id; per-day counts (JST); one mail's detail in a sandboxed
frame; the suppressed-addresses list with Remove.

- **Resend** (confirmation first): refused for `signin-code`, `signin-link`,
  `email-confirm`, test sends, masked rows, suppressed addresses, and a mail
  whose re-render would need a value that was not kept. An invite goes through
  the invite path itself (`inviteOne`, as its inviter): daily slots, the
  address's 30-day window, account, suppression, report block — all apply.
  10 per developer per 10 minutes. The new row links to the first
  (`resend_of`). A stub on a local server.
- **Suppress address**: puts the row's hash in `invite_email_suppression`
  (reason `manual`); **Remove** deletes a hash from it.
- `security_audit`: `mail-log.resend` / `.suppress` / `.unsuppress` — row ids
  and hash prefixes, never an address.
- Tests: `unit/mail-log.test.ts`; QA `scripts/qa/qa-mails.mjs` (suite `mails`).
