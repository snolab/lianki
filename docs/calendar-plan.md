# Study plan, calendar and the node tree — design

Status: **design only, nothing built**. First version merged in #334
(2026-10-30). This revision folds in the owner's rules from 2026-10-30
13:06–13:16: the tree is free-form, everything is a node, types are only tags
and views, agents subscribe to subtrees by events, the partner's study
planning is the main line, and Google Calendar ships dark behind a flag.
The owner's answers of 2026-10-31 are in section 9: the partner applies
changes directly (with undo, a change log and a notice), and an unknown time
zone means UTC, written out, never a guessed zone.

> 中文摘要：一切都是树上的节点（计划、待办、笔记、日历块都一样），"类型"只是标签加视图，
> 不做固定类型，加新用法不用改数据库。普通用户的主线是学习伙伴帮他安排、调整学习计划；
> 开发任务是"进阶用法"。代理按节点 + 深度订阅子树的变更事件（经 lianki-push 推送，不轮询）。
> Google 日历可以合进 main，但放在默认关闭的开关 `FEATURE_GOOGLE_CALENDAR` 后面，
> 审核通过前只有站长能开；内置日历和伙伴规划不依赖它。
> 2026-10-31 决定：伙伴可直接改（保留撤销、变更记录和通知）；取不到时区时用 ISO 日期并写明 UTC。

## 1. Goals and non-goals

**Main line, for every user**

- The Learning Partner arranges and adjusts the user's study plan: it sets up
  goals, daily habits and study times, and rebalances them when reviews pile
  up or a session is skipped. It applies changes directly; every change is
  logged, announced in the chat, and can be undone with one tap.
- A built-in calendar: day and week agenda on the phone (iPhone PWA first),
  with blocks you can create, move and resize, and each day's FSRS review load.

**Underneath: one generic tree**

- Everything is a **node** in one tree per user: a goal, a todo, a note, a
  study session, a reading list, anything. A node's "type" is only its
  **tags**, plus the **views** that pick nodes by tags and fields. The study
  plan is one convention on top: the subtree under a node tagged `plan`.
- New uses need no migration. A new tag, or a new field in `fields`, is enough.
- Agents follow a subtree by **subscription** (node + depth), never by polling.

**Advanced use** (the same model, later in the UI)

- Free-form roots beyond the plan: projects, reading lists, the owner's
  development tasks (today's dev state tree).
- A raw tree editor, and markdown import/export in the state-tree syntax.

**Google Calendar** (merged dark, behind `FEATURE_GOOGLE_CALENDAR`; section 4)

- Read busy times (free/busy only). Write timed nodes to a "Lianki" calendar
  the app creates.
- Later: two-way sync, so a block moved in Google moves in Lianki.

**Later**

- Web Push reminders (none exist yet; section 3).
- A projected review load from simulating FSRS (the MVP counts cards already
  due on each day).
- Other providers (CalDAV, Outlook), ICS export.

**Non-goals**

- Fixed node types, or a table per kind of thing.
- Reading event titles, attendees or locations from the user's calendars.
- Writing to any calendar except the one Lianki created.
- Asking for calendar scopes at sign-in.

## 2. Data model (D1)

One migration, `db/migrations/0018_nodes.sql` (0017 is taken by #317). The
tables are keyed by `user_id`, like `preferences`, because email-keyed rows
break when an address changes. Times are stored as UTC ISO 8601 `TEXT`.
Deletes are soft (`deleted_at`), following
[sync-merge-rules.md](sync-merge-rules.md).

```sql
-- Everything is a node. There is no type column: tags + fields say what a node is for.
CREATE TABLE nodes (
  id         TEXT PRIMARY KEY NOT NULL,
  user_id    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  parent_id  TEXT,                       -- NULL = a root
  slug       TEXT,                       -- optional; makes the node addressable by path
  title      TEXT NOT NULL,
  status     TEXT,                       -- optional: open | doing | blocked | done | dropped ([ ] [~] [!] [x])
  tags       TEXT NOT NULL DEFAULT '[]', -- JSON array: ["plan"], ["habit"], ["todo"], ["note"], anything
  fields     TEXT NOT NULL DEFAULT '{}', -- JSON, free-form; known keys are documented per tag (below)
  sort       REAL NOT NULL DEFAULT 0,
  version    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX idx_nodes_children ON nodes(user_id, parent_id, sort);
CREATE UNIQUE INDEX idx_nodes_slug ON nodes(user_id, COALESCE(parent_id, ''), slug) WHERE slug IS NOT NULL;

-- The time facet: present only on nodes that have a time. It is an index for range
-- queries, not a type. A node is "a calendar block" exactly when it has a row here.
CREATE TABLE node_times (
  node_id         TEXT PRIMARY KEY NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL,
  start_at        TEXT NOT NULL,         -- UTC
  end_at          TEXT NOT NULL,         -- UTC
  tz              TEXT NOT NULL,         -- IANA zone it was planned in
  rrule           TEXT,                  -- RFC 5545 subset: FREQ=DAILY|WEEKLY, BYDAY, INTERVAL, COUNT|UNTIL
  original_start  TEXT,                  -- set on an exception node: which instance of its parent series
  google_event_id TEXT, google_etag TEXT
);
CREATE INDEX idx_node_times_range ON node_times(user_id, start_at);

-- One applied group of edits: the change log the user reads, and the undo record.
-- The partner writes directly (decision 11), so every row starts as applied.
CREATE TABLE changesets (
  id         TEXT PRIMARY KEY NOT NULL,
  user_id    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  summary    TEXT NOT NULL,              -- the one line the user reads
  ops        TEXT NOT NULL,              -- JSON: generic node ops (section 6)
  inverse    TEXT NOT NULL,              -- JSON: ops that undo it, computed at apply time
  by         TEXT NOT NULL,              -- "user" | "agent:<name>" | "google"
  status     TEXT NOT NULL,              -- applied | undone
  created_at TEXT NOT NULL, undone_at TEXT
);
CREATE INDEX idx_changesets_user ON changesets(user_id, created_at);

-- An append-only change log, per user. It feeds the subscription hub (section 6)
-- and lets a reconnecting subscriber resume from a sequence number.
CREATE TABLE node_events (
  user_id TEXT NOT NULL, seq INTEGER NOT NULL,
  node_id TEXT NOT NULL, type TEXT NOT NULL,        -- created | updated | moved | deleted
  ancestors TEXT NOT NULL, old_ancestors TEXT,      -- JSON id chains, root first
  by TEXT NOT NULL, at TEXT NOT NULL,               -- "user" | "agent:<name>" | "google"
  PRIMARY KEY (user_id, seq)
);

-- One row per connected Google account (section 4). Behind the flag.
CREATE TABLE calendar_links (
  user_id            TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  provider           TEXT NOT NULL,      -- google
  account_id         TEXT NOT NULL,      -- the better-auth account row holding the tokens
  calendar_id        TEXT,               -- the "Lianki" calendar Google gave us
  busy_calendars     TEXT NOT NULL DEFAULT '["primary"]',
  sync_token         TEXT,
  channel_id         TEXT, channel_resource_id TEXT,
  channel_token_hash TEXT,               -- SHA-256 of the per-channel secret
  channel_expires_at TEXT,
  status             TEXT NOT NULL,      -- ok | needs-reauth | calendar-gone
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
```

There is also `preferences.time_zone TEXT` (IANA). It is filled from the
browser's `Intl.DateTimeFormat().resolvedOptions().timeZone` on first use and
can be changed on /preferences. **When no zone is known** (NULL, an invalid
name, a request with no browser such as an agent or the API), Lianki uses
UTC and says so: times are written as ISO 8601 with an explicit `Z`
(`2026-10-31T09:00Z`), day buckets are UTC days, and the calendar header reads
"UTC". It never guesses a zone (no Asia/Tokyo default). `node_times.tz` is
then `"UTC"`.

**Why a calendar block is a node with a time facet**, rather than a separate
event that a view links to a node:

1. **One tree.** A block sits under whatever it is for, such as "Daily words",
   a todo, or a reading list. "A block links to any node" is then just
   parenthood. Tree navigation, moving and deleting a subtree work on blocks
   unchanged.
2. **One stream.** Creating, moving or deleting a block is a node event, so a
   subscriber on "Japanese N3" hears that a session under it was moved, with no
   second event source to join.
3. **One op set.** Changesets, undo and permissions work only on nodes.
4. **The facet table is just an index.** Range queries ("this week") hit
   `idx_node_times_range` without scanning JSON, and Google IDs live next to
   the times they sync. Nothing else treats a timed node specially.

Recurrence follows the same pattern. A series is one node with an `rrule`. A
moved, cancelled or done instance is a **child node** of the series with
`original_start`, the same shape as Google's `recurringEventId` +
`originalStartTime`. Views hide these occurrence children by default.
Instances are expanded in the app, in `tz`, so a 07:00 session stays at 07:00
across DST.

**Tags and views, not types.** `lib/tree/tags.ts` documents the known keys in
`fields` for each tag, and validates them softly. It caps sizes and drops wrong
types for known keys, and keeps unknown keys untouched (up to 8 KB of
`fields`). A new tag or key is a code change only. If a field becomes hot
enough to need an index, add a VIRTUAL generated column with an index on it.
That is one small migration with no data rewrite. Starting conventions:

| Tag | Meaning | Known fields |
| --- | --- | --- |
| `plan` | the root of a study plan (one per user, created on first use) | — |
| `goal` | something to reach | `targetDate`, `metric` |
| `habit` | a recurring practice | `minutesPerDay`, `days`, `listId`, `newPerDay` |
| `todo` | a one-off action | `due` (local date) |
| `note` | free text | `body` |
| `session` | a study block (it also has a time facet) | `covers` (`reviews` / `new` / `reading`) |

Views are picked by tag and facet: **Plan** is the subtree under `#plan`,
**Calendar** is every node with a time facet, **Todo** is everything with a
status, and **Tree** is everything. A node can appear in several views.

**FSRS due load** works as in #334. `lib/plan/due-load.ts` buckets
`fsrs_notes.card_due` and `word_cards.card_due` per local day (at most 60
days), counting overdue cards on today. It returns
`{ day, pages, words, estMinutes }`, with `estMinutes` taken from the user's own
pace (median `word_reviews.elapsed_ms`, defaulting to 8 s a word and about
2 min a page). It counts only reviews that are already scheduled.

**The dev state tree** (`docs/state-tree.md`, ProgressHub) stays as it is: it
is public and the owner's alone. User nodes render with the same `StateTree.tsx`,
since status marks and nesting are the same. Showing his dev tree next to his
own nodes is advanced use.

## 3. Built-in calendar

The calendar does not depend on Google or on the flag.

**Route and copy.** `/plan`. Ordinary users see "Study plan" (学习计划) and
"Calendar" (日历), never "node" or "tree". The chat menu's Tree shows "My
plan" first. Other roots appear under "More" once a user has any.

**Views (mobile first)**

- **Day agenda** (the phone default): a vertical time line from 05:00 to 24:00,
  scrolled to now. Timed nodes are cards showing the parent's title as a small
  label. Google busy times, when connected, are grey bands with no text. A load
  strip at the top reads "Today: 143 reviews · ~22 min", with a tap-through to
  /next.
- **Week**: seven columns (swipe between weeks), each topped by a small bar for
  the day's load. A day whose load exceeds the time planned for it gets a warm
  accent.
- **Plan**: the `#plan` subtree as a tree, with today's sessions under their
  habits.

**Editing.** Tap an empty slot to create a 30-minute `session` node. By default
it goes under the habit or goal you pick in the sheet, or under the plan root.
Long-press and drag to move it (15-minute snap), or drag the bottom edge to
resize. For a series, a move asks "this one / all future"; "this one" creates
an occurrence child. Edits are optimistic, with an undo toast.

**Due reviews** are a per-day quantity, not nodes: the load strip and bars,
plus "covers ~60 of 143" on a session tagged with `covers: reviews`.

**Reminders.** There is no Web Push today: `public/sw.js` has no `push`
handler. Google's own event reminders cover connected users (when the flag is
on). Web Push comes later: VAPID keys, a `push_subscriptions` table, and
aes128gcm payloads built with Web Crypto, scheduled by a per-user Durable
Object alarm (a one-shot timer, not polling).

**Design** ([design-principles.md](design-principles.md)). The time grid fills
the screen. The view switcher, date header and "+" button are glass overlays
(`oklch(from var(--background) l c h / 0.6)`, blur 12px, hairline edge), with
scroll-padding so 05:00 and 24:00 can still scroll clear of them. All colours
are oklch: tag hues at equal lightness (e.g. `oklch(0.72 0.12 250)`), and busy
bands `oklch(0.6 0 0 / 0.18)`. Tap targets are at least 40px. Arrow keys move a
block by 15 minutes. The page respects reduced motion and reduced
transparency. Screenshots are iPhone size, light and dark.

## 4. Google Calendar: flag, scopes, consent, tokens

**Feature flag.** Google Calendar code may merge to `main`, but it stays dark.

- **`FEATURE_GOOGLE_CALENDAR`**, a `vars` entry in `wrangler.jsonc`, with the
  values `off` (the default), `owner` or `on`.
- It is read in one place, `lib/features.ts`:
  `googleCalendarEnabled(email): boolean` is true for `on`, or for `owner`
  when `isOwner(email)` (`lib/owner.ts`, `OWNER_EMAILS`).
- **Owner toggle for testing:** under `owner`, a switch on /dev (owner only,
  stored in his preferences) turns it on or off for his own account, so he can
  test both states without a deploy.
- **It gates:** the `genericOAuth` provider's registration (it is not
  registered at all when off), every `/api/calendar/google/*` route (404 when
  off), the webhook, the "Connect Google Calendar" button, busy bands, and the
  partner's use of busy times.
- **It does not gate:** nodes, the built-in calendar, due load, subscriptions,
  or the partner's planning. These never import Google code paths.
- **Turning it on:** `on` only after Google's verification passes (decision 3).

**Scopes (least privilege).**

- **`calendar.app.created`:** creates secondary calendars and manages events
  only on calendars this app created. We use it to write timed nodes to
  "Lianki".
- **`calendar.freebusy`:** reads busy intervals only, with no details. We use
  it to find free slots.

Rejected for the MVP:

- `calendar.events`, which is read/write on every calendar;
- `calendar.readonly`, which exposes titles, attendees and locations;
- `calendar.calendarlist.readonly`, which would let the user pick which
  calendars count as busy. We can add it later if asked.

To check in a spike: that `events.watch` and `syncToken` work on the
app-created calendar under `calendar.app.created` alone.

**Google verification.** Every Calendar scope is **sensitive**, not
restricted, so no CASA assessment is needed. Google still requires:

- the domain verified in Search Console;
- a home page and a privacy policy on lianki.com, stating Limited Use
  compliance;
- a justification for each scope;
- a demo video;
- brand verification.

Plan on **2–6 weeks of wall-clock time**. Until then, the app runs in
"Testing" status: 100 hand-added test users, and refresh tokens expire after 7
days. That is what the `owner` value is for.

**Separate OAuth client in its own GCP project.** The sign-in client shares a
project with Drive and YouTube tools (`lib/google-auth-url.ts`), and
verification covers the whole project. A new "Lianki" project gets a client
used only for the calendar. The sign-in config stays untouched:
`openid email profile`, and `include_granted_scopes` still stripped.

**Incremental authorization (better-auth 1.5.4).** Calendar access is asked for
on /plan, never at sign-in. We use the `genericOAuth` plugin with `providerId:
"google-calendar"`: Google discovery, the new client, the two scopes plus
`openid email`, `accessType: "offline"`, `prompt: "consent"`, and PKCE. The
user links it to the session they already have with
`authClient.oauth2.link({ providerId: "google-calendar" })`.

- That gives a separate `account` row, so Google sign-in never overwrites its
  tokens.
- A scope the user leaves unticked degrades gracefully: the scope that was
  granted is read back.

**Tokens.** They are stored in the `account` row, with
`account.encryptOAuthTokens: true` (AES under `BETTER_AUTH_SECRET`; existing
plaintext rows stay readable). `auth.api.getAccessToken` refreshes them. An
`invalid_grant` sets the link to `needs-reauth`, and /plan shows "Reconnect".

## 5. Sync (all behind the flag)

**Free/busy.** `freebusy.query` over `busy_calendars` for the range in view.
The result is held for the request only and **never stored**.

**Lianki → Google.** On connect we create the "Lianki" calendar and store its
id. Every timed node in the user's tree maps to one event. A series maps to a
recurring event, and an occurrence child maps to an instance override. Each
event carries `extendedProperties.private.liankiNodeId` and the node
`version`. The trigger is the node event stream (section 6): a server-side
Google subscriber on the user's root (depth all, only nodes with a time facet)
writes after each D1 commit, in `waitUntil`. A failed write retries on the
next event or the next /plan visit, not on a timer.

**Google → Lianki** (later; no polling, owner rule):

- `events.watch` on the Lianki calendar delivers to
  `POST /api/calendar/google/webhook`. We check the per-channel token
  (SHA-256 stored) and the channel and resource ids.
- A notification runs `events.list` with the stored `syncToken`. A 410 means a
  full resync.
- Channels expire (about a week) and are renewed by a per-user Durable Object
  alarm one day before expiry, or when /plan is opened with under two days
  left.
- Changes from Google are applied as ordinary node ops `by: "google"`, so
  subscribers hear them like any other edit.

**Conflict rules**

1. An echo of our own write (same `liankiNodeId`, an etag we hold) is ignored.
2. A time or title change in Google wins if the event's `updated` is newer
   than the node's `updated_at`; otherwise Lianki's version is pushed back.
   Last writer wins, per node.
3. An event deleted in Google soft-deletes the node (a tombstone), so it can be
   undone from Lianki.
4. An event added directly in the Lianki calendar becomes a `session` node
   under an "Inbox" child of the plan root.
5. If the Lianki calendar was deleted (404), the link becomes `calendar-gone`,
   and /plan offers "Recreate". The nodes stay.
6. A node moved onto a busy time is allowed, and gets a warning badge.

## 6. Subscriptions and the Learning Partner

### Subscriptions (event-driven, by node and depth)

**Hub.** A new Durable Object class, `TreeHub`, in the existing **lianki-push**
Worker, with one instance per user (`idFromName(userId)`). It uses the
hibernation API, as VersionHub, DebugHub and ProgressHub do, so idle sockets
cost nothing. The socket is `GET /api/version/tree`, which the existing zone
route `/api/version/*` already covers.

**Publishing.** The main Worker writes the node change and its `node_events`
row in one D1 batch. Then, in `waitUntil`, it POSTs the event to
`/internal/tree` over the `PUSH` service binding, which is the same path
`/internal/publish` uses. Each event carries the node's ancestor id chain (and
the old chain for a move), so the hub can match depth without reading D1.

**Who may connect**

- **The user's own pages:** checked by the session cookie through the `MAIN`
  binding, as the debug sockets already are.
- **Agents:** with a **node-scoped token** the main Worker mints:
  `base64url({userId, node, agent, maxDepth, exp}) . HMAC`, the same shape as
  progress tokens. It is valid for at most 7 days. An agent can only subscribe
  inside its node, and only as deep as `maxDepth`.

**Protocol (JSON over the socket)**

```ts
// client → hub
{ op: "sub", sub: "s1", node: "<node id>", depth: 1, has?: "time", tags?: ["habit"], since?: 1042 }
{ op: "unsub", sub: "s1" }

// hub → client
{ op: "ev", sub: "s1", seq: 1043, type: "created" | "updated" | "moved" | "deleted",
  node: { id, parent, title, status, tags, time?: { start, end, rrule } },  // no `fields`: fetch if needed
  from?: "<old parent id>", changed?: ["title", "time"], by: "user" | "agent:<name>" | "google" }
{ op: "reset", sub: "s1" }   // `since` is older than the hub's buffer: refetch the subtree over HTTP
```

**Matching rules**

- **Depth** counts levels below `node`. `0` means the node itself, `1` means it
  and its children, `-1` means the whole subtree.
- **Filters:** `has: "time"` and `tags` narrow the subscription further.
- **Moves:** a move is delivered to every subscription that sees either the
  old or the new position. One that sees only the old position gets it as a
  `moved` event whose new parent is outside its view, which the client treats
  as leaving.
- **Resume:** `seq` is per user. The hub buffers the last 500 events, and on
  reconnect a client sends `since` to catch up; anything older gets `reset`.
- **Batching:** events for the same node within 1 s are coalesced into one.

**Who subscribes to what**

| Subscriber | Subscription |
| --- | --- |
| The main partner (one per user) | `#plan` root, `depth: 1`: goals and habits added, done or dropped. It is **shallow**. |
| A sub-agent attached to a goal, e.g. "JLPT N3" | that node, `depth: -1`: every session, todo and note under it |
| The /plan page | the node in view, `depth: 2`, plus root `has: "time"` for the calendar |
| The Google writer (server side, flag on) | root, `depth: -1`, `has: "time"` |
| The owner's dev agents (advanced) | their dev subtree, as with ProgressHub today |

### The partner's tools

**Generic (they work on any node).** These are HTTP endpoints, called with the
user's session or a node-scoped token, and each is checked against the
token's subtree.

- **`tree.read(node, depth)`:** the subtree, with tags, status, fields and
  times.
- **`tree.find(query?, tags?, has?, under?)`:** a search.
- **`calendar.read(from, to)`:** timed nodes in the range, the due load per
  day, and busy bands (busy bands only when the flag is on and the user is
  connected).
- **`calendar.freeSlots(from, to, minutes, window?)`:** the gaps between busy
  times, timed nodes and quiet hours (23:00–07:00 by default).
- **`tree.subscribe(node, depth, filters)`:** opens the socket subscription
  above.
- **`changes.apply(summary, ops[])`:** writes the ops **directly**, in one D1
  batch with their `changesets` row (summary, ops, inverse, `by`). An op is
  one of `create`, `update` (title, status, tags, fields, time), `move` or
  `delete` (soft). At most 50 ops per changeset.
- **`changes.undo(id)`:** applies the inverse ops as a new changeset, all or
  nothing. If a node it touches has changed since (its `version` moved on), the
  undo stops with a 409 naming that node instead of overwriting the newer edit.
  A restore brings back exactly the subtree its delete took (each delete has a
  unique stamp).
- **`changes.log(from?, under?)`:** the change log, newest first.

**Plan helpers (on top).** Each helper only composes generic ops into one
changeset, so nothing is plan-specific below this layer.

- **`plan.get()`:** the `#plan` subtree plus the next 7 days' load. It creates
  the plan root if it is missing (an empty node).
- **`plan.addGoal(title, targetDate?)`:** a `goal` node.
- **`plan.scheduleHabit(node, minutesPerDay, days, window)`:** finds slots,
  then adds a `session` series under the habit.
- **`plan.rebalance(from, to)`:** reads the due load and the skipped
  occurrences, then moves sessions, and lowers new cards rather than adding
  hours.

**How the partner works**

- **The main partner.** It wakes on its shallow subscription (a new goal),
  or when the user talks to it in chat.
- **Sub-agents.** When a goal gets active work, the main partner attaches a
  sub-agent with a token scoped to that goal. The sub-agent wakes on deep
  events under it: two skipped sessions in a row, or a session moved in Google.
  It then applies a fix. It may not write outside its node.

**Direct apply, with undo, log and notice** (decision 11). The partner does not
ask first. Every changeset:

- **Notice:** appears in the chat as a card with its one-line summary ("Moved
  Tue and Thu reviews to 07:30, added 20 min Sunday"), a before/after day
  strip, and **Undo**. When the chat is closed, the minimized bar shows it as a
  floating line; Web Push carries it later (P7).
- **Log:** /plan has a "Changes" list (newest first, who did it, Undo per
  row), filtered to the subtree in view. It is the `changesets` table.
- **Undo:** one tap, any time; undo is itself a changeset, so it can be undone.
  Google gets the undo like any other edit.
- **Guard rails:** at most 50 ops per changeset and 20 changesets an hour per
  agent; deletes are soft; an agent writes only inside its token's subtree.

## 7. Privacy and security

These follow the standards declared for PAY.JP in
[security-measures.md](security-measures.md).

- **Stored:** nodes, time facets, changesets, `node_events`, the link row and
  encrypted OAuth tokens. `node_events` holds ids and types only, never titles,
  and is trimmed after 30 days.
- **Not stored:** busy times, other calendars' events, or any Google data
  beyond our own calendar's events.
- **Logged:** ids, counts and status codes only. Never tokens, titles, fields
  or busy ranges. Errors go through `lib/safeError.ts`.
- **Subscriptions:** the hub sends only nodes inside the token's subtree. Socket
  payloads leave out `fields` (notes can be private), so a subscriber fetches
  them over HTTP under the same check.
- **Disconnect** (from /plan or /profile):
  - revoke at `oauth2.googleapis.com/revoke`;
  - stop the channel;
  - delete the `account` row and `calendar_links`;
  - ask whether to delete the "Lianki" calendar in Google (the default is to
    keep it).
- **Account deletion:** `ON DELETE CASCADE` on every table, and revoking
  Google access first.
- **Webhook:** a per-channel secret compared in constant time, a rate limit
  through `auth_throttle`, and the work done in `waitUntil`.
- **Limited Use:** Google data is used only to schedule that user's study, is
  never used for AI training, and is never passed to another user. The
  partner sees busy bands as bare intervals.
- **Privacy policy:** a Google Calendar section, required before verification.

## 8. Phases and estimates (agent hours)

Ordered by the main line: the partner planning comes first, with the generic
model underneath it, and Google ships dark.

| Phase | Scope | Agent hours |
| --- | --- | --- |
| P0 | This document (#334 + this revision) | 1 |
| P1 | Migration (nodes, node_times, changesets, node_events), `lib/tree/` repos + tag conventions, `time_zone`, `due-load.ts`, `GET /api/tree`, `GET /api/plan/load`, tests | 4.5 |
| P2 | `TreeHub` subscriptions: publish over `PUSH`, node + depth matching, scoped tokens, resume, tests | 4 |
| P3 | Partner: generic tools, plan helpers, change notice card, change log, undo, sub-agent attach | 5 |
| P4 | Built-in calendar + Plan view: day/week, create/move/resize, series and occurrences, load strip, QA (iPhone, light + dark) | 6 |
| P5 | Google connect behind `FEATURE_GOOGLE_CALENDAR`: genericOAuth, token encryption, the Lianki calendar, free/busy, one-way writer as a subscriber, disconnect, owner toggle | 5.5 |
| P6 | Two-way sync: webhook, sync tokens, DO channel renewal, conflict rules | 5 |
| P7 | Web Push reminders | 4 |
| P8 | Privacy policy text, verification package, hardening | 2 |
| P9 | Advanced use: raw tree editor, more roots, markdown import/export | 3 |

**Total ≈ 40 agent hours**, up from 29.5 in #334. The increase comes from
the generic tree (+1.5), the subscription hub (+4), the generic tools and
sub-agents (+1), the flag (+0.5), the advanced phase (+3) and this revision
(+0.5).

- **User-facing MVP (P1–P4):** about 19.5 agent hours, with no Google
  dependency.
- **Google, merged dark (P5 + P8):** about 7.5 more. Google's review adds 2–6
  weeks of wall-clock time on top.

**First PR (P1, no UI), as built:** `db/migrations/0018_nodes.sql`;
`lib/repos/nodesD1.ts` (subtree by depth, paths, timed range, plan root,
changesets with inverse + undo, node_events with ancestor chains);
`lib/tree/tags.ts`, `lib/tree/tz.ts` (UTC fallback), `lib/plan/due-load.ts`;
routes `GET /api/tree`, `POST|GET /api/tree/changes`,
`POST /api/tree/changes/<id>/undo`, `GET /api/plan/tree`, `GET /api/plan/load`;
`timeZone` on `/api/preferences`; tests in `unit/tree-*.test.ts` and
`unit/plan-due-load.test.ts`. It does not touch auth, OAuth or the flag. Not
yet: agent tokens and rate limits on writes (P2/P3), the hub publish (P2).

## 9. Decisions (2026-10-31)

The owner answered on Slack, 2026-10-31 00:14 JST: "时区取不到用isodate 写明utc，9允许直接改，
其它全按推荐". Mapped to the list below, every item is approved as recommended,
except two:

- **11. Partner writes: apply directly, without an Apply tap.** Undo, a
  visible change log and a notice of each change stay (section 6). The
  `proposals` table became `changesets`.
- **12. Time zone: the browser's; when it cannot be read, ISO dates with UTC
  written explicitly** (`2026-10-31T09:00Z`), not Asia/Tokyo (section 2).

Items 1–3 follow the owner's own rules of 2026-10-30 and are approved with
them. Item 10 now reads "writing only inside its subtree" (sub-agents apply
directly too).

The list as it was asked:

1. Should a calendar block be a node with a time facet (`node_times`), rather
   than a separate event linked to a node?
2. No type column: tags plus free-form `fields`, with tag conventions in code?
3. Turn on `FEATURE_GOOGLE_CALENDAR=on` only after Google's verification
   passes, with `owner` (plus your /dev switch) until then?
4. A separate GCP project and OAuth client for the calendar, with sign-in
   unchanged?
5. Scopes `calendar.app.created` + `calendar.freebusy` only?
6. Start Google verification alongside P1–P4, with you doing the Search Console
   step and Google's emails?
7. Turn on `encryptOAuthTokens` for all accounts, including the sign-in ones?
8. Should the built-in calendar and partner planning be free, with Google sync
   Pro-only?
9. `TreeHub` as a new per-user Durable Object in lianki-push, separate from the
   global ProgressHub?
10. A sub-agent per active goal, scoped to that goal's subtree, writing only
    through proposals?
11. Should the partner write only after an Apply tap, always, with no
    auto-apply?
12. Default time zone: the browser's, falling back to Asia/Tokyo?
13. Should your dev tree show next to your own nodes in the chat Tree (advanced
    use)?
