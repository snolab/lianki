# Preferences that follow the account

Phases 1–3 built (2026-10-31; phase 4, push, is not). Owner request (2026-10-31 02:21 JST): habit settings
follow the account and sync across devices and origins. Settings that belong
to one device stay on it. The Experimental settings on /words (New swipe,
Heavy swipe and its tuning, paper scrolls) are synced too (owner, 02:22 JST).

This also fixes the dev origin opening with default settings: once it signs in
through the dev bridge, it pulls the owner's preferences like any other device.

It adds a fifth row to the table in [ui-state.md](ui-state.md). The **account**
mode is a localStorage copy (the device's cache, read for the first paint)
kept in step with the server.

## 1. Every key, classified

Classes:

- **synced**: account mode. The value is kept on the server and follows the
  account to every device and origin.
- **device**: localStorage, never leaves the device. It depends on the
  hardware, holds a device URL, or makes no sense anywhere else.
- **session**: sessionStorage or memory, this tab only (ui-state.md).
- **not a pref**: queues, logs, sync bookkeeping, event names. Out of scope
  and left as they are.

The store column gives the account-mode store that will hold the key, as
`<store>.<field>`, which is also the server key.

### /words study settings and the swipe

| Key today                      | Setting                                   | Class      | Server key           | Reason                                                                              |
| ------------------------------ | ----------------------------------------- | ---------- | -------------------- | ----------------------------------------------------------------------------------- |
| `lk:words-show-all`            | Show all meanings                         | **synced** | `words.showAll`      | a reading habit                                                                     |
| `lk:words-sound`               | Read aloud                                | **synced** | `words.readAloud`    | a habit; the mic and speaker state is a separate device fact                        |
| `lk:words-server-voice`        | Server voice                              | **synced** | `words.serverVoice`  | a voice choice, not a device feature                                                |
| `lk:words-swipe-speak`         | Speak on swipe                            | **synced** | `words.speakOnSwipe` | a habit                                                                             |
| `lk:words-grade-tones`         | Grade tones                               | **synced** | `words.gradeTones`   | a habit                                                                             |
| `lk:words-paper-scrolls`       | Paper scrolls (Experimental)              | **synced** | `words.paperScrolls` | owner, 02:22                                                                        |
| `lk:swipe-ab`                  | New swipe (Experimental)                  | **synced** | `swipe.variant`      | owner, 02:22. Telemetry still tags each row with the variant                        |
| `lk:pref:swipe-feel` `.preset` | Heavy swipe (Experimental)                | **synced** | `swipe-feel.preset`  | owner, 02:22                                                                        |
| `lk:pref:swipe-feel` `.tweaks` | swipe tuning sliders                      | **synced** | `swipe-feel.tweaks`  | owner, 02:22. One field, because the sliders reset together with the preset         |
| `lk:pref:motion`               | Turn off animations                       | **synced** | `motion.animations`  | a preference about motion, not the screen. `system` (the default) is never uploaded |
| `lk:words-fullscreen`          | Full screen                               | device     | —                    | owner: depends on the screen and the browser                                        |
| `lk:ui:swipe-tuner`            | tuner panel open                          | session    | —                    | a panel                                                                             |
| `lk:ui:words`                  | list, Settings open, help, scroll anchors | session    | —                    | UI state of this tab (ui-state.md)                                                  |
| `lk:words-collapsed:<base>`    | collapsed groups                          | device     | —                    | one key per page, unbounded, and it tracks the list's layout. Revisit if asked      |
| `lk:swipe-ab-dev`              | random id for the A/B count               | device     | —                    | it identifies this device; syncing it would defeat the count                        |
| `?swipe=`, `?feel=`            | one-load overrides                        | URL        | —                    | never stored, by design                                                             |

### Appearance, language, navigation

| Key today                                        | Setting                  | Class      | Server key               | Reason                                                                                          |
| ------------------------------------------------ | ------------------------ | ---------- | ------------------------ | ----------------------------------------------------------------------------------------------- |
| cookies `INTLAYER_LOCALE`, `NEXT_LOCALE`, `lang` | UI language              | **synced** | `ui.locale`              | owner. Only an explicit pick in LanguageSwitcher is uploaded, never a detected language (see 6) |
| `lk:paper`                                       | paper skin               | **synced** | `ui.paper`               | a taste. The inline before-paint script keeps reading the local copy                            |
| `lk:pref:nav-pins`                               | pinned pages             | **synced** | `nav.pins`               | app paths only (validated: `/…`, no origin)                                                     |
| `lk:sidebar`                                     | sidebar collapsed        | device     | —                        | depends on screen width                                                                         |
| `lk:ui:nav`                                      | drawer, recent pages     | session    | —                        | this tab                                                                                        |
| `lk:home:lang`                                   | home (sites) language    | **synced** | `home.lang`              | the language you study                                                                          |
| `lk:home:pins`                                   | pinned sites             | **synced** | `home.pins`              | the home matrix's public site URLs only (a site of your own cards stays on the device)          |
| `lk:lab:immersion:langs`                         | lab: language order      | **synced** | `lab.immersionLangs`     | a habit (phase 3, low priority)                                                                 |
| `lk:lab:immersion:transpose`                     | lab: transposed table    | **synced** | `lab.immersionTranspose` | a habit (phase 3)                                                                               |
| `lk:input-modality`                              | touch or keyboard last   | device     | —                        | what is in your hands on this device                                                            |
| `lk:first-run`                                   | local or account answer  | device     | —                        | asked before there is an account to sync to                                                     |
| `lk:storage-persist`                             | persistent storage asked | device     | —                        | a browser permission on this device                                                             |

### Chat widget (packages/debug-chat)

The `lk:debug*` names are moving to `lk:agent*` (`storage-keys.ts`). Both are
listed once.

| Key today                                     | Setting                     | Class            | Server key         | Reason                                                                                                                                                                                   |
| --------------------------------------------- | --------------------------- | ---------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lk:agent-speech-rate`                        | speech rate                 | **synced**       | `chat-voice.rate`  | owner                                                                                                                                                                                    |
| `lk:voice-out`                                | speech or cloud voice       | **synced**       | `chat-voice.out`   | a voice choice, like Server voice                                                                                                                                                        |
| `lk:agent-chat-speak` (`lk:debug-chat-speak`) | read replies aloud          | **synced**       | `chat-voice.speak` | a habit                                                                                                                                                                                  |
| `lk:voice-aec`                                | echo cancel, mic stays open | device           | —                  | **decided: device.** It depends on the hardware: speakers next to the mic need it off on some devices, headphones never do. Syncing it would break barge-in on one device to fix another |
| `lk:agent:mic`                                | mic on                      | device → session | —                  | owner: device. A mic must not open by itself on another device                                                                                                                           |
| `lk:agent:stt-hint`                           | STT language hint           | device           | —                  | learnt from typed lines, cheap to relearn; not a choice                                                                                                                                  |
| `lk:agent-chat-open` (`lk:debug-chat-open`)   | chat open, full screen      | device → session | —                  | owner: full screen is device-local                                                                                                                                                       |
| `lk:agent-chat-pos` (`lk:debug-chat-pos`)     | bar position                | device → session | —                  | owner: depends on the screen                                                                                                                                                             |
| `lk:debug-local-stt`                          | local STT URL               | device           | —                  | **never on the server**: a tailnet URL                                                                                                                                                   |
| `lk:debug-widget-src`, `lk:agent-widget-src`  | hot-loaded widget           | device           | —                  | **never on the server**: a dev-server URL                                                                                                                                                |
| `lk:slots-src`, `lk:tree-src`                 | hot-loaded slots, tree      | device           | —                  | **never on the server**: dev URLs                                                                                                                                                        |
| `lk:debug-clip-sink`                          | clip sink (legacy)          | device           | —                  | **no longer read**: the sink and the recording switch are the hub's (dev-debug-widget.md, "Recording")                                                                                    |
| `lk:pref:clips-device`                        | this device's id            | device           | —                  | names the device for the hub's recording sessions; replaced by the session's id on a handoff                                                                                             |
| `lk:debug`                                    | debug mode                  | device           | —                  | it opens the hub socket from this device; consent is per device                                                                                                                          |
| `lk:debug-tab`                                | tab id                      | session          | —                  | identifies the tab                                                                                                                                                                       |
| `lk:agent-migrated`                           | key rename done             | not a pref       | —                  | bookkeeping                                                                                                                                                                              |

### Userscript (GM storage, other origins)

| Key                                                                                                                                                                             | Class                              | Reason                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| `lk:preferences`                                                                                                                                                                | already server                     | a cache of `/api/preferences` (review order, watch tracking, mobile filters), already per account |
| `lk:heatmap`                                                                                                                                                                    | **synced, later** `script.heatmap` | a habit. Not in the registry yet: the userscript needs its own token path to /api/prefs           |
| `lianki_pos`                                                                                                                                                                    | device                             | the button's position on this screen                                                              |
| `lk:watch-lang`                                                                                                                                                                 | not a pref                         | per-video language overrides; that is card data                                                   |
| `lk:deviceId`, `lk:config`, `lk:c:*`, `lk:card-index`, `lk:queue`, `lk:token`, `lk:note:*`, `lk:markers:*`, `lk:watch:*`, `lk:watch-index`, `lk:watch-dirty`, `lk:nav_intended` | not a pref                         | cards, sync state, caches (sync-architecture.md)                                                  |

### Not prefs (left alone)

`lk:swipe-unsent`, `lk:swipe-log*`, `lk:voice-sent`, `lk:status`, `lk:purge`,
`lk:reloaded-for`, `lk:version-notice` are queues and bookkeeping. `lk:s:<key>`,
`lk:shared-state`, `lk:island-action`, `lk:debug-chat-target` and the `lk:debug`
event are island and widget channels. The IndexedDB stores hold cards.

A new key gets a row here in the same change, with its class and reason.

## 2. Storage

**A new table, not the old one.** The `preferences` table has one typed
column per setting (`mobile_exclude_patterns`, `review_order`,
`watch_tracking`) and one `updated_at` for the row. That gives no per-field
clock, and every new setting would need a migration. It stays as it is for
what it holds, and the userscript keeps reading `/api/preferences`.

`db/migrations/0020_user_prefs.sql` (renumbered to the next free number at
merge time): `user_prefs(user_id → user ON DELETE CASCADE, key, value JSON,
hlc_ts, hlc_counter, device_id, updated_ms)`, primary key `(user_id, key)`.
`updated_ms` is the server's clock at the write and the `?since=` cursor;
client HLCs are not, because a device with a slow clock would hide its rows.
A read with `since` returns 5 s of overlap, so a write that took its time
before a read and committed after it is not missed.

D1 only. MongoDB is the frozen rollback copy (AGENTS.md); on the Mongo
backend the route answers `{}` to reads and 503 to writes, so a rollback
degrades to device-local preferences rather than failing.

**One registry, zod.** `lib/prefs/schema.ts` maps each server key to a zod
schema (`PREF_SCHEMAS`), with `checkPref(key, value)` for the route and the
client alike. It lives in the app, not `@lianki/core`, because some schemas
need the app's catalogs (the swipe's `FEEL_RANGES`, the locales, the home
matrix's sites). The chat widget never needs it: the app's engine syncs the
chat's keys.

**The route.** `/api/prefs` (`app/api/prefs/route.ts`):

- `GET [?since=<cursor>]` returns `{ user, prefs: {key: {value, hlc}}, cursor }`.
- `PATCH {ops: [{key, value, hlc}]}` returns `{ user, prefs, rejected }`: the
  winning row of every key sent, so a client whose write lost adopts the
  winner, and the keys refused. It does not advance the cursor.
- `user` is the account id, so a device notices an account switch.

**Checks:**

- An unknown key is refused (400). The server deploys before any client that
  sends a new key.
- A value that fails its schema is refused. Nothing coerces or truncates.
- Strings are bounded by their schema. Nothing free-form is stored: no URL,
  host, file path or note text (see 5).
- Caps: 2 KB of JSON per value, 50 ops and 16 KB per request, and 100 rows
  per user. Over the row cap, a new key is refused. The registry has about 30 keys today.
- An HLC timestamp more than 60 s ahead of the server's clock is clamped to
  the server's now. That bounds a fast device clock (edge case 8 in
  sync-merge-rules.md).

**Shape changes.** A field whose type changes gets a new key
(`swipe-feel.tweaks2`). The old row is no longer read, and nothing has to be
migrated on the server. Reads filter out keys that are not in the registry.

**Resetting** a setting writes its default value. Nothing is deleted, so
there are no tombstones.

## 3. When it syncs

All of it is event-driven. Nothing polls (owner rule).

| When                              | What                                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| first paint                       | the local copy (`lk:pref:<store>`), as today. Works offline; no flash, no wait                      |
| page load, after hydration        | `GET /api/prefs?since=` (an empty answer when nothing changed), merged in                           |
| sign-in (session appears)         | full `GET`, then the first-sync step (see 6)                                                        |
| the tab becomes visible, `online` | `GET ?since=`: this is how another device's change arrives in phase 2                               |
| a change                          | written locally at once, pushed 1 s after the last change (the sliders send one request, not fifty) |
| `pagehide`                        | the outbox is flushed with `fetch(…, {keepalive: true})`                                            |
| offline                           | the outbox waits in `lk:pref-sync` and is sent on `online`                                          |

**Other tabs on the same origin** follow through the `storage` event, as
local stores already do. Only the tab that made the change pushes it: the
others see a value with an HLC they already hold.

**Other devices and origins, phase 4: push.** After a `PATCH` the main Worker
tells lianki-push (service binding `PUSH`) `{user, kind: "prefs", cursor}`.
The hub sends it to that user's open pages, and each page runs the
`GET ?since=`. The version socket every page holds today is the same for
all users, so this needs a per-user channel: the per-user Durable Object that
calendar-plan.md plans (`TreeHub`) can carry it, authenticated the way the
debug socket is (the cookie, checked against the main Worker). Until then a
change on the phone reaches the Mac the next time the Mac's tab is shown,
which is when it is seen anyway.

## 4. Conflicts

Each server key is its own LWW register with an HLC, compared the way
sync-merge-rules.md compares cards (`compareHLC` from `@lianki/core`:
timestamp, then counter, then device id). It is per field, so changing Show
all meanings on the phone and the speech rate on the Mac never overwrite each
other.

- The server applies a write only if its HLC is strictly newer, in one
  statement (`INSERT … ON CONFLICT DO UPDATE … WHERE (excluded.hlc_ts,
excluded.hlc_counter, excluded.device_id) > (…)`). Two writes racing on D1
  cannot both win.
- The client applies a pulled row the same way, so a slow response cannot
  undo a newer local change.
- Clocks: a client's next HLC is after both its own clock and every HLC it
  has seen, the usual HLC receive rule. The device id is a random id kept in
  the `lk:pref-sync` record. It is not the swipe A/B id (`lk:swipe-ab-dev`)
  or the userscript's `lk:deviceId`, so the three stay unlinkable.
- There are no deletions, so the tombstone and "not-exists wins" rules do
  not apply. A missing row means the default.
- Account switch (edge case 13): the `lk:pref-sync` record carries the user
  id. When the user changes, the outbox is dropped, not sent to the other
  account, and the device pulls the new account's values.

## 5. Privacy

- Stored on the server: the registry keys and their values, which are
  booleans, enums, numbers in range, app paths and the home matrix's public site URLs. Also the HLC
  and a random device id (not a hardware id or user agent).
- Never stored: device URLs or tailnet hostnames (`lk:debug-local-stt`,
  `lk:debug-widget-src`, `lk:slots-src`, `lk:tree-src`, `lk:debug-clip-sink`),
  the mic state, debug mode, anything typed. These keys are not in the
  registry, and an unknown key is refused, so a client bug cannot upload
  them either. A unit test asserts that no registry schema accepts a string
  containing `://` or `.ts.net`.
- **Data export:** `/api/export/yaml` already includes `preferences`. It gains
  a `prefs:` map of key to value, without the clocks.
- **Account deletion:** `user_prefs` is keyed by `user_id`, with `ON DELETE
CASCADE` in the plan calendar-plan.md sets out for account deletion. Until
  self-serve deletion exists, deleting a user by hand includes
  `DELETE FROM user_prefs WHERE user_id = ?`, added to the same runbook.
- Signed out: nothing is sent. The device keeps its local copy as before.

## 6. Moving the current keys, and the dev origin

**Decided: the server wins, and local values fill the gaps** (once per device
and account):

1. Each account store reads its legacy key once (`lk:words-show-all`,
   `lk:swipe-ab`, `lk:paper`, …) into `lk:pref:<store>`. This is the pattern
   in ui-state.md, already used for the swipe feel. Only a key that is
   present counts as "set by the user". An absent key is just the default.
2. On the first sync after sign-in, for every field:
   - if the server has a row, the server wins and the local value is
     replaced;
   - if not, and this device set the field, it is uploaded with a fresh HLC;
   - if neither, nothing happens and the field stays at its default.
3. The device records `migrated: <userId>` and from then on uses plain HLC LWW.

Why not "newest wins": the legacy keys carry no timestamp, so "newest" would
mean "whichever device signs in last", and an old tablet would overwrite the
phone. With fill-the-gaps the first device to sync sets the account's
habits, and the others adopt them. That matches the request: settings follow
the account.

A change made while signed out gets an HLC like any other. On the next
sign-in it is pushed and LWW decides. It is a later, deliberate choice, so it
usually wins.

**UI language.** It is uploaded only when LanguageSwitcher picks one
(`lk:ui-locale`), never from `navigator.languages` or `?lang=`. A pulled
`ui.locale` sets the `lang` and `NEXT_LOCALE` cookies. It takes effect on the
next page load: nothing reloads under you mid-study.

**Account switch.** Pending changes of the old account are dropped, and the
new account's values are pulled. The device's values never fill the new
account's gaps: that is only for the device's first account.

**The dev origin.** The owner's whole-page dev server signs its own sessions.
Its guard sends `/api/prefs` to lianki.com with `x-lianki-dev-bridge`
(`BRIDGED_PATHS` in `scripts/dev/whole-page-guard.ts`), and `/api/prefs` joins the bridged
routes in `lib/dev-bridge-user.ts` (#363: owner only, a wrong secret is
refused, never a cookie fallback). The dev page then pulls the owner's
account prefs after the bridge sign-in and pushes changes back. It is the
same account, so a setting changed on the dev page is changed on the phone
too. Its device-local keys (the widget source and the local STT URL, which
are the point of a dev origin) never leave it.

## 7. How it is built

**`@lianki/ui-state` gets `storage: "account"`.** It is stored exactly as
`local` (`lk:pref:<name>`), so turning a local store into an account store
moves no data and the before-paint script for `lk:pref:motion` keeps
working. Each write fires `lk:pref-write`. `motion`, `swipe-feel` and
`nav-pins` are account stores.

**The engine** is `@lianki/ui-state/account` (`createPrefSync`), app-free and
tested with fakes against the real repo (`unit/prefs-sync.test.ts`). The app
gives it **bindings** (`lib/prefs/bindings.ts`), one per server key: how to
read the local value, write a server value back, and the default. There are
two kinds:

- a field of an account store, applied with `setState` when the page has the
  store, else into its persisted JSON;
- a plain localStorage key the feature already reads (`lk:words-show-all`,
  `lk:paper`, `lk:swipe-ab`, the chat's `lk:agent-speech-rate`, `lk:voice-out`
  and `lk:agent-chat-speak`, …). These keys are kept, so the code that reads
  them needs no change. That includes the before-paint paper script and the
  chat widget, which cannot import the app. Writers call `notePrefWrite()`.
  An applied value fires `lk:pref-applied`, which `usePref`, read aloud, New
  swipe and the paper picker follow.

**Change detection is by comparison.** `scan()` compares each binding's value
with the last one seen, kept in `lk:pref-sync` and shared by the device's
tabs, and stamps what changed. A writer that forgets `notePrefWrite()` is
still caught on the next tab hide or page load. The first look at a key on a
device stamps nothing: the first sync decides about that value.

**`app/components/PrefSync.tsx`** is mounted in the app layout for signed-in
pages. It loads `lib/prefs/client.ts` lazily, so the schemas stay out of the
first paint, which uses the local copy anyway. It wires the events from
section 3.

## 8. Phases

Estimates in agent hours (agent wall-clock time).

| Phase              | What                                                                                                                                                                                                                                     | Estimate |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1. Server          | migration `user_prefs`, D1 repo, `lib/prefs/schema.ts` registry (zod), `GET`/`PATCH /api/prefs` with the caps, HLC clamp and conditional upsert, export, unit tests                                                                      | 2.5 h    |
| 2. Client, /words  | `account` mode and the engine in `@lianki/ui-state`; the /words prefs, swipe variant, swipe feel, motion and paper moved onto account stores; legacy key carry-over and fill-the-gaps; fetch on visible and `online`; QA on two browsers | 3.5 h    |
| 3. The rest        | the chat's voice keys (rate, out, speak; aec local); UI language; nav and home pins; lab; `/api/prefs` on the dev bridge. Built 2026-10-31, except the userscript's `script.heatmap`, left for later                                     | 2.5 h    |
| 4. Push (optional) | per-user channel in lianki-push, `prefs` event after a write, pages refetch on it                                                                                                                                                        | 2 h      |

Phases 1 to 3 take about 8.5 agent hours, or about 10.5 with push. Each phase
ships on its own: after phase 1 nothing changes for users, and after phase 2
the /words settings follow the account.
