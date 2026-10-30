# UI state: what is kept, where, and for how long

This page sets one rule for every piece of state the interface keeps. It
covers the app, its hot islands and the chat widget.

## The four places

| Place                                    | Lifetime                                                       | Scope                     | For                                                         |
| ---------------------------------------- | -------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------- |
| **sessionStorage** `lk:ui:<name>`        | until the tab closes; survives a refresh and a hot island swap | this tab only             | UI state: panels, positions, drafts, the current selection  |
| **localStorage** `lk:pref:<name>`        | until cleared                                                  | this device, all its tabs | device preferences: theme, font size, voice rate, swipe feel |
| **The URL** (`?list=`, filters)          | as long as the link                                            | shareable                 | what someone could bookmark or send                         |
| **The server** (`/api/preferences` etc.) | always                                                         | the account, all devices  | synced preferences, and all business data                   |

Rules:

- **Business data never goes in sessionStorage.** That means cards, grades,
  queues, review logs, notes and anything the server owns. Those belong to the
  server, plus the offline copies in IndexedDB (`lib/words/idb.ts`). A UI
  store may hold a _pointer_ to them, such as a list id or the key of the word
  at the top of the screen. It never holds the thing itself.
- **The URL wins** when it carries the same state. sessionStorage only fills
  in when the URL is silent. For example, `/words` with no `?list=` reopens
  this tab's list by replacing the address, with no extra history entry.
- **Per-tab isolation is the default** for UI state. Two tabs on /words keep
  their own list, scroll and panels. A preference that should follow you
  across tabs goes in localStorage, and other tabs pick it up through the
  `storage` event.
- **Event-driven.** Stores write when the state changes. A scroll position is
  written 200 ms after scrolling stops. Nothing polls.

## How: `@lianki/ui-state`

The factory lives in `packages/ui-state` (`@lianki/ui-state`). It has no
imports from the app, so the chat widget can use it too.

```ts
import { createUiStore, useUi } from "@lianki/ui-state";

const panel = createUiStore("chat-panel", 1, { open: false, draft: "" }, { storage: "session" });
const open = useUi(panel, (s) => s.open); // React, SSR-safe
panel.setState({ open: true }); // anywhere
```

- **zustand + persist.** The factory is built on zustand's `persist`
  middleware, with JSON stored as `{state, version}`.
- **Storage never throws.** In private mode, on a quota error or in a
  sandboxed iframe, the store falls back to memory.
- **Stored values are checked.** By default only keys of the initial state
  with the same type are kept. You can pass a `clean(stored)` of your own.
- **`version` + `migrate(stored, fromVersion)`.** Without `migrate`, an old
  version is dropped and the store starts from the initial state.
- **SSR-safe.** The server never reads storage. `useUi` renders the initial
  state for the server and while hydrating, then the stored state. Selectors
  must return stable values: a primitive, or a reference held in the state.
- **One instance per page,** kept on `globalThis.__lkUiStores` by key.
  - A hot-swapped island, or the hot-loaded chat widget with its own bundled
    copy of the package, gets the page's store and its state.
  - Creating the same key with another `version` throws, so the island's
    error boundary falls back instead of corrupting the state.
- **`keys`** restricts what is written. The rest stays in memory for the
  page.

Why zustand: the owner chose it over redux (2026-10-30). It is small, and a
store works outside React, which matters for the swipe core's per-frame code.

## The inventory

Each line gives the state, where it is kept, and its status. `→` marks a
target that is not built yet.

### Routing, panels, modals

| State                                   | Where                                     | Status                                     |
| --------------------------------------- | ----------------------------------------- | ------------------------------------------ |
| current word list                       | URL `?list=`, then session `lk:ui:words`  | done (/words, /alphabets)                  |
| /words Settings panel open              | session `lk:ui:words`                     | done                                       |
| /words keyboard help strip (`?`)        | session `lk:ui:words`                     | done                                       |
| swipe tuner panel open                  | session `lk:ui:swipe-tuner`               | done                                       |
| slip action sheet open                  | memory (it is modal, closed on refresh)   | intentional                                |
| sidebar collapsed                       | local `lk:sidebar`                        | → `lk:pref:sidebar`                        |
| phone drawer open                       | memory, `navUi` (lib/nav/ui-store.ts)     | done: the bottom island opens it too       |
| recent pages (nav)                      | session `lk:ui:nav`                       | done                                       |
| pinned pages (nav)                      | local `lk:pref:nav-pins`                  | done                                       |
| first-run answer                        | local `lk:first-run`                      | a device fact, stays                       |

### Chat widget (packages/debug-chat, another lane)

| State                                     | Where                                                        | Status                                  |
| ----------------------------------------- | ------------------------------------------------------------ | --------------------------------------- |
| bar position                              | local `lk:debug-chat-pos`                                    | → session `lk:ui:chat` (per tab)        |
| chat open, full-screen log                | local `lk:debug-chat-open`                                   | → session `lk:ui:chat`                  |
| tree level / expanded node                | —                                                            | → session `lk:ui:chat`                  |
| chat scroll, draft                        | —                                                            | → session `lk:ui:chat` (draft text is UI, not a message) |
| mic on                                    | local `lk:agent:mic`                                         | → session (a mic should not reopen in a new tab by itself) |
| speech rate, voice out, echo cancel       | local `lk:agent-speech-rate`, `lk:voice-out`, `lk:voice-aec` | → `lk:pref:chat-voice`                  |

### Cards and the swipe

| State                                       | Where                                         | Status                                         |
| ------------------------------------------- | --------------------------------------------- | ---------------------------------------------- |
| swipe feel preset and token tweaks          | local `lk:pref:swipe-feel`                    | done (was `lk:swipe-feel`, carried over once)  |
| swipe variant (js / native)                 | local `lk:swipe-ab`                           | → `lk:pref:swipe` (keep the A/B tag)           |
| a card flipped / revealed, pinned rows      | memory                                        | → session, by word key, if wanted              |
| swipe in progress                           | memory (refs in the core)                     | intentional: a gesture does not survive a refresh |
| grades, queue, cards                        | server + IndexedDB                            | never in a UI store                            |

### Search, filter, sort, study mode

| State                                           | Where                                   | Status                                  |
| ----------------------------------------------- | --------------------------------------- | --------------------------------------- |
| /words scroll position                          | session `lk:ui:words` anchors           | done: the word at the top, per list, restored when the queue loads |
| show all meanings, speak on swipe, grade tones, server voice, paper scrolls, scroll after swipe | local `lk:words-*` (usePref)            | device prefs → `lk:pref:words` |
| list picker search / filter / sort              | — (none on /words today)                | → URL when added (shareable)            |
| study mode (one list, a group, "study all")     | URL `?list=` (`all`, a group id)        | done                                    |
| home pins, home language                        | local `lk:home:*`                       | device prefs → `lk:pref:home`           |

### Read-aloud

| State                          | Where                         | Status                                 |
| ------------------------------ | ----------------------------- | -------------------------------------- |
| read-aloud progress (sentence) | memory                        | → session, per page, if reading resumes |
| volume, rate, voice            | local (per feature)           | → `lk:pref:voice`, later server-synced |

### Appearance and language

| State                | Where                                   | Status                         |
| -------------------- | --------------------------------------- | ------------------------------ |
| theme (light / dark) | the system (`prefers-color-scheme`)     | → `lk:pref:theme` if a switch is added |
| language             | intlayer, as today                      | stays                          |
| font size            | —                                       | → `lk:pref:appearance`         |
| animations off       | local `lk:pref:motion` (`system` until chosen; lib/motion-pref.ts) | done: /words Settings → Turn off animations; `<html data-motion="off">` set before paint |
| paper texture        | local `lk:paper`                        | stays a plain key: app/layout.tsx reads it in an inline script before paint, to avoid a flash |

### Not UI state (left alone)

These are queues, logs and sync bookkeeping, and they stay where they are:
`lk:swipe-unsent`, `lk:swipe-log*`, `lk:voice-sent`, `lk:status`, `lk:purge`,
`lk:reloaded-for` and `lk:version-notice`. Shared state between islands
(`lk:s:<key>`, zod-checked, [dev-hot-islands.md](dev-hot-islands.md)) is a
separate channel. It is for an island to talk to another island, not to
persist UI.

## Migrating an existing key

Read the old key once, write it into the store, and remove the old key. The
swipe feel does this in `lib/words/swipe-core.tsx`. Migrate only if the
store is still at its initial state, so a newer choice is never overwritten.

## For the chat widget

`packages/debug-chat` may not import the app, but it can import
`@lianki/ui-state`, which is a workspace package. Use one store per concern,
named `chat`, `chat-voice` and so on, with session storage for UI state and
local storage for preferences. Because stores are kept per page on
`globalThis`, the hot-loaded widget bundle and the built-in one share state
across a reload of the widget.
