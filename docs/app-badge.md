# App-icon badge

Owner request, 2026-11-09 15:31 JST: a number on Lianki's installed app icon
(home screen, dock) through the Badging API: unanswered Li ask cards plus
cards due.

Behind the flag **`pwa.app-badge`** (default off;
https://lianki.com/dev/flags#pwa.app-badge), `audience: "owner"`. On: the
owner only (`isDev`) gets it and the setting row; an allowlist may come later.
Off: nobody, the owner included; the row is hidden and a page clears any badge
left over. One gate, `appBadgeOn(flags, owner)` (`lib/app-badge-gate.ts`), for
`/api/badge`, the Settings row and `AppBadge`. (2026-11-09: briefly on for
everyone 16:35–16:52 JST before this gate shipped.)

## What it counts

The synced preference `notify.badge` (`lk:notify-badge`,
[prefs-sync.md](prefs-sync.md), "Notifications"), set in Settings →
Notifications (`AppBadgeSettings.tsx`, strings `app-badge.content.ts`):

| mode        | number                         |
| ----------- | ------------------------------ |
| `off`       | none, the badge is cleared     |
| `ask-cards` | open asks                      |
| `due-cards` | due cards                      |
| `both`      | the sum (default)              |

- **Open asks**: `chat_line` rows of this account with `ask = 1` and no
  `answer`, from the last 7 days (an ask expires within 7 days at most;
  [chat-history.md](chat-history.md)).
- **Due cards**: page cards (`fsrs_notes`, not deleted) plus /words words
  (`word_cards`) whose `card_due` is now or earlier.
- At most 9999. Pure logic: `lib/app-badge.ts` (`badgeCount`, `seenOn`,
  `applyDelta`, `parseCounts`, `parseBadgeMode`).

## How counts are fetched

`GET /api/badge[?mode=…]` (`app/api/badge/route.ts`, session cookie) answers
`{on, mode, asks, due, count}`: numbers only, no text, no ids. One D1 query
with only the parts the mode needs (`lib/app-badge-server.ts`), reused per
isolate for 15 s per account and mode; the response itself is `no-store`.
Without `mode` (the service worker) the account's synced value decides.
Flag off or not D1: `{on: false}`. Signed out: 401.

## When it updates

Nothing polls. Event-driven only:

- **The page** (`app/components/AppBadge.tsx`, mounted in `app/(app)/layout.tsx`
  for signed-in users; logic in `badgeController`): on open, when the tab
  becomes visible again, and when the setting changes (this tab, another tab,
  or the account sync). At most one fetch per 30 s per tab unless forced.
- **Seen**: answering an ask card (`DebugEval` `sendAnswer`) takes one off
  the asks; grading a due page card (`ReviewClient`) or a due word's first
  grade (`WordsClient`) takes one off the due cards; the last page card
  graded asks the server again. On `/review` and `/words` the due part is not
  counted, on `/chat` the asks part (`seenOn`).
- **The service worker** (`public/sw.js`, `push` event): a payload with
  `{badge: n}` sets n; `{badge: {asks, due, mode?}}` is combined with the
  mode, from the payload or the page's last `{type: "badge-mode"}` message
  (kept in the `lianki-badge-v1` cache); no counts: one `GET /api/badge`.
  No web push subscription exists yet: this handler is ready for when
  lianki.com sends pushes.
- **Sign-out** clears it (`lib/sign-out.ts`).

## Support

Feature-detected everywhere: no `setAppBadge`, or it refuses, does nothing,
silently. Chrome/Edge show it for an installed app on desktop and Android;
Safari on macOS for a web app in the Dock; iOS and iPadOS 16.4+ only for a web
app added to the Home Screen, with notification permission. The setting's
help text says so in one line; no prompt nags for permission.

## Tests

- `unit/app-badge.test.ts`: count per mode, pref parsing, the controller
  (open, throttle, seen, refresh, screens), the server's counts and cache
  against a test D1, and `public/sw.js`'s push and message handlers, all with
  the Badging API mocked.
- `scripts/qa/qa-app-badge.mjs` (suite `app-badge`): flag gate; a new account
  with 2 due cards and 1 open ask gets `setAppBadge(3)`; the setting changes
  it to 1, persists across a reload and reaches `/api/prefs`; `/chat/history`
  clears it. 360 px, light and dark.
