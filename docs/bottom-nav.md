# Bottom island navigation

A floating glass island fixed at the bottom of a phone screen, as in Slack on
mobile and the iOS 26 tab bar. It is not draggable. Desktops keep the
permanent left sidebar, and tablets keep the glass sidebar overlay.

## What it does

Four buttons, in this order: Home, Menu, ＋ Create, Search (owner,
2026-10-31). ＋ is the largest (60px against 56px) and sits third, just right
of the capsule's middle. On a 390–430px phone held in the right hand, that is
the easiest reach for the thumb.

| Button   | Tap                                                    |
| -------- | ------------------------------------------------------ |
| Home     | `/home`; shows the due-review badge                     |
| Menu     | opens the drawer (an edge swipe does too); sync dot     |
| ＋ Create | the Create sheet                                        |
| Search   | the command palette (Ctrl/⌘ K anywhere)                |

- **Create** offers a link as a card (paste it), words from an Anki deck
  (`/words/import`, .apkg), importing cards and backups (`/import`) and
  making words with AI (`/ai-vocab`). Two things are left out because the app
  has no path for them yet: typing in a single new word, and CSV import. Photo
  capture is left out for the same reason.
- **The Learning Partner** is no longer on the island. It is reached through
  its chat bar, and through a "Learning Partner" row in the drawer (debug
  mode, where the chat is on).
- **Badges.** Home shows the due-review count: the sum of `due` over the
  cached word lists. A dot on Menu shows when the device is offline (grey) or
  has reviews waiting to sync (amber).
- **Behaviour.**
  - The island shrinks to a small capsule when you scroll down. It comes back
    when you scroll up or stop scrolling.
  - It hides while the on-screen keyboard is open (`visualViewport`).
  - It pads itself by the safe areas, and its tap targets are 44px or more.
  - Where `navigator.vibrate` exists, a tap gives a short haptic tick.

## Search

One palette over the app and the learner's own content. Queries never leave
the device.

1. **At once, on every keystroke:** the app's own pages and commands
   (`APP_NAV`, Create). These are static.
2. **Then, without blocking typing:** his content from an index in IndexedDB
   (`lianki-search`, `lib/nav/islands/search-idb.ts`):
   - lists (by name);
   - words (term, reading, meaning, example);
   - cards (page cards — LiCards in the UI, heading `groupCards`);
   - the study plan (roadmap goals);
   - for the owner, the state tree.

   Each group is scanned in slices that yield to input. It is appended below
   the groups already shown, which never move. A newer keystroke cancels the
   round in progress (a generation counter).

- **The index** is built on the device:
  - Lists and words come from the /words offline copy: the cached lists, and
    the catalogs (or imported decks) already downloaded.
  - Cards, the plan and the tree are downloaded whole, never per query, at
    most every 10 minutes.
  - Each source has a stamp. A sync, when the palette opens, rebuilds only the
    sources that changed and drops the ones that are gone.
  - Words are capped at 3000 per list. When a list is cut, a "Search all
    words" row lifts the cap.
- **Opening a result** goes straight there:
  - a list opens its page;
  - a word opens its list with that word at the top (the `lk:ui:words`
    anchor);
  - a card opens its page in a new tab;
  - a plan goal opens `/roadmap`;
  - a tree node opens `/dev/roadmap`.
- **Pasted links.** A pasted URL offers "Add {url} as a card"
  (`/add-note#url=`).
- **AnkiWeb.** The last row is always "Search more on AnkiWeb". It opens
  AnkiWeb's own search in a new tab (noopener). The query is encoded and
  never fetched by Lianki.

## The /words help strip

Owner's decision (2026-10-31): the island and the strip never stack.

- On a phone, while the island shows, the strip `[data-words-help]` is made
  invisible with `opacity: 0`.
  - Not `display: none`: /words still measures the strip to pad its list.
  - It is click-through (`pointer-events: none`). An overlay must never
    swallow a tap meant for the page (owner, 2026-10-31); only the capsule
    itself takes taps. The island's full-width wrapper, the tip's
    surroundings and the closed drawer, palette and sheet take none either.
    qa-words touches the capsule's rim where it used to touch the strip.
  - It is stretched to at least the island's height
    (`--lk-island-cover`), so no row rests under the island.
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
