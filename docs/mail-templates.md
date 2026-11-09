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
