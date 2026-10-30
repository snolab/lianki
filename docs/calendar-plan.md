# Calendar and study plan — design

Status: **design only, nothing built** (2026-10-30). Owner request, in-app chat
2026-10-30 13:04–13:06.

> 中文摘要：学习伙伴的主要工作是帮用户安排和调整学习计划。计划存在 D1（每个用户自己的
> /plan 树），内置日历先做（手机日/周视图，复习量按天显示），伙伴可读计划、找空档、
> 提议改动，用户确认后才写入。Google 日历后做：只读忙闲（freebusy）+ 只写 Lianki 自建日历，
> 用单独的 OAuth 客户端单独授权，不在登录时要权限；双向同步靠 webhook，不轮询。

## 1. Goals and non-goals

**MVP**

- A per-user study plan (goals → milestones → habits) the Learning Partner can
  read and change, shown as a `/plan` branch in the chat's Tree view.
- A built-in Lianki calendar: day and week agenda on the phone (iPhone PWA
  first), study blocks you can create, move and resize, and each day's FSRS
  review load shown on it.
- Partner tools: read the plan and the calendar, find free slots, propose a
  schedule change; the user confirms before anything is written.
- Google Calendar, one way at first: read the user's busy times (free/busy
  only) and write Lianki study blocks to a dedicated "Lianki" calendar that
  the app creates.

**Later**

- Two-way sync (a block moved in Google moves in Lianki), via push
  notifications.
- Reminders by Web Push (none exist yet; see section 3).
- A projected review load from simulating FSRS (the MVP counts cards already
  due on each day).
- Other providers (iCloud/CalDAV, Outlook), ICS export.

**Non-goals**

- Reading event titles, attendees or locations from the user's calendars.
- Writing to any calendar except the one Lianki created.
- Asking for calendar scopes at sign-in.
- A general-purpose calendar app. Lianki only shows study blocks, due load and
  (for connected users) anonymous busy bars.

## 2. Data model (D1)

New tables go in one migration, `db/migrations/0017_calendar.sql` (or the next
free number). They are keyed by `user_id`, like `preferences`, not by email:
email-keyed rows break when an address changes. All times are stored as UTC
ISO 8601 `TEXT`, like the rest of the schema. Deletes are soft (`deleted_at`),
following [sync-merge-rules.md](sync-merge-rules.md).

```sql
-- The plan: a tree per user. path is the slug path under /plan,
-- e.g. /plan/japanese/n3-grammar. It is what the Tree view and the partner address.
CREATE TABLE plan_items (
  id          TEXT PRIMARY KEY NOT NULL,
  user_id     TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  parent_id   TEXT,                    -- NULL = top level under /plan
  path        TEXT NOT NULL,
  title       TEXT NOT NULL,
  kind        TEXT NOT NULL,           -- goal | milestone | habit | task
  status      TEXT NOT NULL,           -- open | doing | done | dropped
  target      TEXT,                    -- JSON, e.g. {"minutesPerDay":30,"listId":"…","newPerDay":10}
  due_on      TEXT,                    -- a local date, YYYY-MM-DD, in the user's time zone
  sort        REAL NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
  UNIQUE (user_id, path)
);

-- A study block: one time slot, or a recurring series.
CREATE TABLE study_blocks (
  id              TEXT PRIMARY KEY NOT NULL,
  user_id         TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  plan_item_id    TEXT,                -- what the block is for (optional)
  title           TEXT NOT NULL,
  kind            TEXT NOT NULL,       -- review | new | reading | listening | other
  start_at        TEXT NOT NULL,       -- UTC
  end_at          TEXT NOT NULL,       -- UTC
  tz              TEXT NOT NULL,       -- IANA zone the block was planned in
  rrule           TEXT,                -- RFC 5545 subset: FREQ=DAILY|WEEKLY, BYDAY, INTERVAL, COUNT|UNTIL
  series_id       TEXT,                -- set on an exception row: the series it overrides
  original_start  TEXT,                -- with series_id: which instance (UTC)
  status          TEXT NOT NULL,       -- planned | done | skipped | cancelled
  source          TEXT NOT NULL,       -- user | partner | google
  google_event_id TEXT, google_etag TEXT,
  version         INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX idx_blocks_user_time ON study_blocks(user_id, start_at);

-- What the partner proposed, and what the user did with it (also the undo record).
CREATE TABLE plan_proposals (
  id         TEXT PRIMARY KEY NOT NULL,
  user_id    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  summary    TEXT NOT NULL,            -- one line the user reads
  ops        TEXT NOT NULL,            -- JSON: [{op:"create"|"move"|"delete"|"update", …}]
  status     TEXT NOT NULL,            -- pending | applied | rejected | expired | undone
  created_at TEXT NOT NULL, decided_at TEXT
);

-- One row per connected Google account (section 4).
CREATE TABLE calendar_links (
  user_id            TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  provider           TEXT NOT NULL,    -- google
  account_id         TEXT NOT NULL,    -- the better-auth account row holding the tokens
  calendar_id        TEXT,             -- the "Lianki" calendar Google gave us
  busy_calendars     TEXT NOT NULL DEFAULT '["primary"]',
  sync_token         TEXT,
  channel_id         TEXT, channel_resource_id TEXT,
  channel_token_hash TEXT,             -- SHA-256 of the per-channel secret
  channel_expires_at TEXT,
  status             TEXT NOT NULL,    -- ok | needs-reauth | calendar-gone
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
```

Plus `preferences.time_zone TEXT` (IANA). It is filled from the browser's
`Intl.DateTimeFormat().resolvedOptions().timeZone` on first use, with
`Asia/Tokyo` as the fallback, and can be changed on /preferences.

**Recurrence.** A series is one row with `rrule`. An instance that was moved or
cancelled is its own row with `series_id` and `original_start`. This is the
same model as Google's `recurringEventId` + `originalStartTime`, so sync maps
rows one to one. Instances are expanded in the user's zone (`tz`) in the app,
never in SQL, so "every day at 07:00" stays at 07:00 across DST. Asia/Tokyo has
no DST, but other users' zones do.

**FSRS due load.** The cards are already indexed for this:
`fsrs_notes(email, card_due)` and `word_cards(email, list_id, card_due)`. A new
`lib/plan/due-load.ts` returns, for each local day in a range (at most 60
days):

```ts
type DayLoad = { day: "2026-11-02"; pages: number; words: number; estMinutes: number };
```

- Overdue cards count on today.
- Days are bucketed in SQL by shifting `card_due` by the zone's UTC offset
  (`date(card_due, '+540 minutes')` for Tokyo). For a zone with DST, the range
  is split at its transitions, with one query per piece.
- `estMinutes` comes from the user's own pace: the median `word_reviews.elapsed_ms`
  over the last 30 days (default 8 s a word), and about 2 minutes a page
  until watch stats give a better figure.
- Limitation: it only counts reviews that are already scheduled. A card
  reviewed tomorrow comes back later, which this does not predict. The later
  phase simulates that with ts-fsrs.

**Link to the state tree.** The dev state tree (`docs/state-tree.md`) is public
and the owner's alone, so user plans never go in it. The `/plan` branch is
built from `plan_items` for whoever is signed in. It uses the same node shape
and status marks, so `StateTree.tsx` renders it unchanged: status open/doing/done
maps to `[ ]` `[~]` `[x]`, and blocks due today show as children. In the
owner's chat it sits next to the dev tree. The partner addresses nodes by path
(`/plan/japanese/n3-grammar`), as agents already do with `/words/swipe`.

## 3. Built-in calendar

**Route.** `/plan`, a client page that works offline from the last fetched
range and is installable like the rest of the PWA.

**Views (mobile first)**

- **Day agenda** (the default on a phone): a vertical time line, 05:00–24:00,
  scrolled to now. Study blocks are full-width cards. Busy times from Google
  are flat grey bands with no text. At the top, a load strip reads "Today: 143
  reviews · ~22 min" with a tap-through to /next.
- **Week**: seven narrow columns (horizontal swipe between weeks), each topped
  by a small load bar for the day, scaled to the user's typical daily load. An
  overloaded day (load over the time planned for it) gets a warm accent.
- On desktop: week by default, with the day view as a side panel.

**Editing.** Tap an empty slot to make a 30-minute block. Long-press a block,
then drag to move it (snapping to 15 minutes), or drag its bottom edge to
resize. Tap opens a sheet with the title, kind, plan item, repeat, and
"done / skip". For a recurring block, a move asks "this one / all future".
Every edit is optimistic, with an undo toast.

**Due reviews** are not calendar events. They are a per-day quantity: the load
strip and bars above, plus a "review" block's card showing "covers ~60 of 143".

**Reminders.** There is no Web Push today: `public/sw.js` has no `push`
handler, and `workers/push` is the version notice and the chat hub, not
notifications. So:

- MVP: for Google-connected users, Google's own reminders on events in the
  Lianki calendar (a popup 10 minutes before by default). This needs no new
  infrastructure.
- Later: Web Push (iOS 16.4+ when installed to the Home Screen), with VAPID
  keys (a new secret), a `push_subscriptions` table, and aes128gcm payloads
  built with Web Crypto, so nothing Node-only runs. Scheduling uses a
  per-user Durable Object whose alarm is set to the next reminder: a one-shot
  timer, not polling.

**Design** ([design-principles.md](design-principles.md)). The time grid fills
the screen edge to edge. The view switcher, the date header and the "+" button
are glass overlays (`oklch(from var(--background) l c h / 0.6)`, blur 12px,
hairline edge), with scroll-padding so 05:00 and 24:00 can still scroll clear
of them. All colours are oklch. Block kinds use one hue each at equal
lightness, for example review `oklch(0.72 0.12 250)`, new `oklch(0.72 0.12 150)`,
reading `oklch(0.72 0.12 60)`. Busy bands are `oklch(0.6 0 0 / 0.18)`.
Tap targets are at least 40px, drag has a keyboard fallback (arrow keys move by
15 minutes), and it respects reduced motion and reduced transparency.
Screenshots are iPhone size, light and dark.

## 4. Google Calendar: scopes, consent, tokens

**Scopes (least privilege)**

| Scope | Gives | Why |
| --- | --- | --- |
| `calendar.app.created` | Create secondary calendars, and manage events only on calendars this app created | Writing study blocks to "Lianki". It cannot see or touch any other calendar. |
| `calendar.freebusy` | Busy intervals only, with no titles or details | Finding free slots |

Rejected for the MVP:

- `calendar.events`: read and write on **every** calendar. It is far more than
  we need.
- `calendar.readonly`: exposes titles, attendees and locations. Its only gain
  would be the partner saying "after your dentist", which is not worth holding
  that data.
- `calendar.calendarlist.readonly`: it would let the user pick which calendars
  count as busy. Without it, free/busy covers `primary` plus any calendar IDs
  the user pastes in. We can add it later if people ask.

To check in the P5 spike: that `events.watch` and `events.list` with a
`syncToken` work on the app-created calendar under `calendar.app.created`
alone.

**Google verification.** Every Calendar scope is **sensitive**, not
**restricted**. That means no CASA third-party security assessment (that is
for Gmail and Drive restricted scopes), but it still needs:

- the domain verified in Search Console (lianki.com), and the home page and
  privacy policy on it;
- a privacy policy that says what Google data is used and how, and states
  compliance with the Google API Services User Data Policy, Limited Use;
- a justification for each scope, and a demo video showing the consent screen
  and each scope in use;
- brand verification (name, logo, support email).

Timeline: brand review takes days, and sensitive-scope review usually a few
weeks. Plan on **2–6 weeks of wall-clock time**, with the owner on Google's
email thread. Until verification:

- In "Testing" status the app is limited to 100 hand-added test users, and
  their refresh tokens **expire after 7 days**, so the owner re-consents
  weekly.
- Unverified "In production" status shows the "Google hasn't verified this
  app" screen, with a 100-user lifetime cap.

**Use a separate OAuth client in its own GCP project.** The sign-in client
shares a project with Drive and YouTube tools (see `lib/google-auth-url.ts`).
Verification covers the whole project's consent screen, so those tools' scopes
would be pulled into the review. A new project, "Lianki", with its own client
is used **only** for the calendar. It is also the only way to leave the
current sign-in config untouched. The sign-in client keeps
`openid email profile` and keeps stripping `include_granted_scopes`.

**Incremental authorization with better-auth (1.5.4).** Calendar access is
asked for on /plan ("Connect Google Calendar"), never at sign-in. We use the
`genericOAuth` plugin with `providerId: "google-calendar"` (Google's discovery
URL, the new client, `scopes: [openid, email, calendar.app.created,
calendar.freebusy]`, `accessType: "offline"`, `prompt: "consent"`, PKCE). The
user links it to the session they already have with `authClient.oauth2.link({
providerId: "google-calendar" })`.

- That gives a **separate `account` row**. Google sign-in never overwrites its
  tokens or scope, which is the risk if we reuse the `google` provider with
  `linkSocial({ scopes })`: each sign-in rewrites that row.
- Its email may differ from the Lianki account's. That is allowed, and the
  connected address is shown.
- If the user leaves a scope unticked on Google's screen, we read the granted
  `scope` back and degrade: with no free/busy, slots ignore Google; with no
  app.created, there is no writing.

**Tokens.** They are stored in better-auth's `account` row, with
`account.encryptOAuthTokens: true` (AES under `BETTER_AUTH_SECRET`). This is
new: today tokens are stored in plain text. It is harmless for existing rows,
because the library leaves non-encrypted tokens readable. Access tokens come
from `auth.api.getAccessToken({ providerId: "google-calendar", userId })`,
which refreshes when they expire. If the refresh fails with `invalid_grant`
(revoked, or the 7-day expiry in Testing), the link becomes `needs-reauth`
and /plan shows "Reconnect".

## 5. Sync

**Read: free/busy.** `freebusy.query` runs over the link's `busy_calendars`,
for the range on screen or the range the partner asks about. Results are held
in memory for the request only and are **never stored**.

**Write: Lianki → Google.** On connect we create the "Lianki" calendar
(`calendars.insert`, in the user's time zone) and store its `calendar_id`. Each
block maps to one event (a series maps to a recurring event with the same
RRULE, and an exception row maps to an instance override). Each event carries
`extendedProperties.private.liankiBlockId` and the block `version`. Writes
happen after the D1 write, in `waitUntil`, and record `google_event_id` and
`google_etag`. A failed write is retried on the next change or on the next
visit to /plan, not on a timer.

**Two-way: Google → Lianki** (a later phase; no polling, owner rule)

- `events.watch` on the Lianki calendar, delivered to
  `POST /api/calendar/google/webhook` with a random per-channel token. We
  check the token against `channel_token_hash` and the channel and resource
  IDs.
- A notification only says "changed". The handler runs `events.list` with the
  stored `syncToken` and applies the delta. A 410 response means the token
  expired, so we do a full resync of the calendar and get a new token.
- Channels expire (Google sets the limit, about a week). They are renewed by a
  per-user Durable Object alarm set for one day before expiry, and also
  whenever the user opens /plan with under two days left. Both are one-shot
  events, not probes.

**Conflict rules**

1. An echo of our own write (same `liankiBlockId`, and an etag we already hold)
   is ignored.
2. A time or title change made in Google updates the block if the event's
   `updated` is newer than the block's `updated_at`. Otherwise Lianki's
   version is pushed back. Last writer wins, per block.
3. An event deleted in Google sets the block to `cancelled`, a tombstone. We
   never hard-delete, so it can be undone from Lianki.
4. An event the user added directly to the Lianki calendar becomes a block
   with `source: google`.
5. If the Lianki calendar was deleted (404), the link becomes `calendar-gone`
   and /plan offers "Recreate" (blocks stay in D1).
6. A block moved onto a busy time is allowed, and gets a warning badge.

## 6. The Learning Partner

**Tools.** HTTP endpoints, called with the user's own session, or with a
scoped chat grant on the partner's side of the hub. Each is checked against the
plan's owner.

| Tool | Does |
| --- | --- |
| `plan.read(path?)` | the `/plan` subtree, with status and targets |
| `calendar.read(from, to)` | blocks, the due load per day, and busy bands (when connected) |
| `calendar.freeSlots(from, to, minutes, window?)` | gaps between busy times, blocks and the user's quiet hours (default 23:00–07:00) |
| `plan.propose(summary, ops[])` | stores a `plan_proposals` row; **writes nothing else** |
| `plan.apply(proposalId)` | only after the user confirms (below) |
| `plan.undo(proposalId)` | reverses an applied proposal |

**How it uses due load.** It never schedules less review time on a day than
`estMinutes`, and it spreads new cards (`newPerDay`) so the projected review
load stays under the time planned for the day. When load is too high, it
suggests fewer new cards rather than more hours.

**Confirmation UX.** A proposal shows in the chat as a card: a one-line summary
("Move Tue and Thu reviews to 07:30, add 20 min Sunday"), a small before/after
day strip, and **Apply** and **Not now**. Apply writes to D1 first, then
Google. Then the card reads "Applied · Undo". Nothing reaches the calendar
without a tap. Proposals expire after 24 hours. A voice "yes" counts only while
the card is on screen.

## 7. Privacy and security

These follow the same standards as [security-measures.md](security-measures.md),
the measures declared for PAY.JP.

- **Stored:** plan items, blocks, proposals, the link row, and encrypted OAuth
  tokens. **Not stored:** busy times, other calendars' events, or anything from
  Google beyond our own calendar's events.
- **Logged:** IDs, counts and status codes only. Never tokens, event titles or
  busy ranges. `wrangler tail` output stays clean, and errors go through
  `lib/safeError.ts`.
- **Disconnect** (/plan and /profile): revoke at `oauth2.googleapis.com/revoke`,
  stop the watch channel, delete the `account` row and `calendar_links`, and
  ask whether to also delete the "Lianki" calendar in Google (default: keep
  it, since it is the user's).
- **Revoked in Google:** the next refresh fails, so the link becomes
  `needs-reauth` and nothing else is kept.
- **Account deletion:** `ON DELETE CASCADE` on every new table. Revoke runs
  first.
- **Webhook:** a per-channel secret, compared in constant time, rate-limited
  through `auth_throttle`, and work done only in `waitUntil`.
- **Limited Use:** Google data is used only to schedule study blocks for that
  user, is never used for AI training, and is never passed to another user.
  The partner sees busy bands as bare intervals.
- **Privacy policy:** a new Google Calendar section. It is a precondition for
  verification.

## 8. Phases and estimates (agent hours)

| Phase | Scope | Agent hours |
| --- | --- | --- |
| P0 | This document | 0.5 |
| P1 | Migration, repos, `time_zone`, `due-load.ts` + `GET /api/plan/load`, `/plan` tree branch, tests | 3 |
| P2 | Built-in calendar UI: day and week, create/move/resize, recurrence, load strip, QA (iPhone, light and dark) | 6 |
| P3 | Partner tools + proposal card + apply/undo | 4 |
| P4 | Google connect: genericOAuth link, token encryption, create the Lianki calendar, free/busy, one-way write, disconnect | 5 |
| P5 | Two-way sync: webhook, sync tokens, DO channel renewal, conflict rules | 5 |
| P6 | Web Push reminders | 4 |
| P7 | Privacy policy text, verification package (justifications, demo script), hardening | 2 |

**Total ≈ 29.5 agent hours.** The MVP is P1–P4 plus P7, about 20 agent hours.
Google's review adds 2–6 weeks of wall-clock time that is not agent time. P1–P3
need nothing from Google and can ship first.

**First PR (P1, no UI):** `0017_calendar.sql`, `lib/plan/` (repos and
`due-load.ts`, with unit tests including a DST zone), `GET /api/plan/load` and
`GET /api/plan/tree`, and the `time_zone` preference. Nothing touches auth or
OAuth.

## 9. Owner decisions (approve / deny)

1. A separate GCP project and OAuth client, used for the calendar only, with
   sign-in left as it is?
2. Scopes `calendar.app.created` + `calendar.freebusy` only, with no
   `calendar.readonly`?
3. Start Google verification in parallel with P1–P3, meaning you run the
   Search Console step and the Google emails?
4. Turn on `encryptOAuthTokens` for all accounts, sign-in ones included?
5. Should the built-in calendar and partner planning be free, with Google sync
   Pro-only?
6. Default time zone: the browser's zone, falling back to Asia/Tokyo?
7. For channel renewal, is a per-user Durable Object alarm OK under the
   no-polling rule?
8. For MVP reminders, rely on Google's event reminders, with Web Push later?
9. Should the partner write only after an Apply tap, every time, with no
   "auto-apply small moves" setting?
10. Should your own `/plan` show in the chat Tree next to the dev tree?
