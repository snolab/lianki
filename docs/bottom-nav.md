# Bottom island navigation

A floating glass island fixed at the bottom of a phone screen, as in Slack on
mobile and the iOS 26 tab bar. It is not draggable. Desktops keep the
permanent left sidebar, and tablets keep the glass sidebar overlay.

## What it does

| Button  | Tap                                                  | Long press               |
| ------- | ---------------------------------------------------- | ------------------------ |
| Home    | `/home`                                              |                          |
| Menu    | opens the drawer, which also opens with an edge swipe |                         |
| Centre  | Learning Partner in debug mode, otherwise Create      | Create (the shortcuts)  |
| Search  | the command palette                                  |                          |

- **Search** is one palette over pages and commands (`APP_NAV`, Create), word
  lists and words (the offline copy in IndexedDB), cards
  (`/api/fsrs/list?q=`) and, for the owner, state-tree nodes. A pasted URL
  offers "Add {url} as a card" (`/add-note#url=`).
- **Create** offers words from an Anki deck (`/words/import`), a link as a
  card, importing cards and backups (`/import`) and making words with AI
  (`/ai-vocab`).
- **Badges.** Home shows the due-review count, which is the sum of `due`
  over the cached word lists. A dot shows when the device is offline (grey)
  or has reviews waiting to sync (amber).
- **Behaviour.** The island shrinks to a small capsule when you scroll down
  and comes back when you scroll up or stop scrolling. It hides while the
  on-screen keyboard is open (`visualViewport`), pads itself by the safe
  areas, and keeps tap targets at 44px or more inside the thumb zone. Where
  `navigator.vibrate` exists, a long press gives a short haptic tick.

## The /words help strip

Owner's decision (2026-10-31): the island and the strip never stack.

- On a phone, while the island shows, the strip `[data-words-help]` is hidden.
  It uses `visibility`, not `display`, because /words still measures it to
  pad its list.
- Its text moves to a "?" in the drawer header ("Gestures & shortcuts"),
  which opens the same text. The island reads it from the strip, so it stays
  localized and matched to touch or keyboard.
- **First visit:** until the learner has graded anything (no cards over the
  cached lists), the same hint shows once as a dismissible tip above the
  island. It is dismissed into `lk:pref:nav-tip`.
- Tablets and desktops have no island, and the strip stays as it is.

## Sharing the bottom edge with the chat bar

The Learning Partner bar (packages/debug-chat) floats at the bottom right in
debug mode. The two never overlap:

1. **The island docks above the bar.** It measures `[data-debug-chat-row]`,
   using a ResizeObserver plus a MutationObserver for the bar appearing and
   being dragged. If the two overlap horizontally, the island sits 8px above
   the bar's top. Nothing polls.
2. **The partner button opens the chat.** It sends the `chat.open` action
   (`lib/islands/contract.ts`), which the chat lane can listen for. Until it
   does, the button falls back to the bar's own mark button.

The island writes `--lk-bottom-reserve` on `<html>`: the height it covers at
rest. `<main>` pads its bottom by that height, so the last row can scroll
clear of the island (docs/design-principles.md, "Reserve, don't push").

## Code

| File                                   | Role                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| `lib/nav/ui-store.ts`                  | `navUi` (session: drawer open, recent pages), `navPins` (local: pinned pages) |
| `lib/nav/nav-core.ts`                  | the pure rules: ranking, URL detection, compact, keyboard, docking, badges    |
| `lib/nav/islands/BottomIsland.tsx`     | the `nav.bottom` island                                                       |
| `lib/nav/islands/signals.ts`           | its event-driven hooks: scroll, keyboard, chat dock, due/sync, edge swipe     |
| `lib/nav/islands/SearchPalette.tsx`    | the command palette                                                           |
| `lib/nav/islands/CreateSheet.tsx`      | the Create sheet                                                              |
| `lib/nav/islands/NavRows.tsx`          | the `nav.drawer` island: breadcrumbs, pin, pinned and recent pages            |
| `lib/nav/islands/text.ts`              | every label, from `bottom-nav`, `app-shell`, `landing-page`, `learning-partner` |
| `app/components/bottom-nav.content.ts` | the strings, in all locales                                                   |
| `unit/bottom-nav.test.ts`, `unit/nav-core.test.ts` | islands, stores, strings (no literals, oklch only, no polling), rules |

Both are hot islands (docs/dev-hot-islands.md). To preview a change on the
owner's phone, run an islands server from your worktree on a port and path
of your own, e.g.
`bun scripts/dev/islands-server.ts --port 5197 --tailnet /lianki-islands-nav`,
and point `lk:slots-src` at it.

## Share to Lianki

`public/manifest.json` declares a share target. In the installed app
(Android), sharing a page to Lianki opens
`/add-note?url=…&title=…&text=…`. `/add-note` takes the URL from the hash
first, then from the query, then from the first link in `text`. Share sheets
often send the link in `text` rather than `url`.
