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
  offers "Add {url} as a card" (`/add-note?url=`).
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

| File                                  | Role                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| `lib/nav/ui-store.ts`                 | `navUi` (session: drawer open, recent pages), `navPins` (local: pinned pages) |
| `app/components/nav/BottomNav.tsx`    | the `nav.bottom` island's built-in version (nothing until approved)           |
| `app/components/nav/NavDrawerExtra.tsx` | the `nav.drawer` island: pinned, recent and breadcrumbs above the nav list |
| `app/components/bottom-nav.content.ts` | every string, in all locales                                                 |
| `unit/bottom-nav.test.ts`             | slots, stores, strings                                                        |

The island is a hot island (docs/dev-hot-islands.md). It is previewed on the
owner's phone from an agent's worktree and becomes the built-in once he
approves it.
