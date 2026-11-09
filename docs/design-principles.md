# Design principles

## Content fills the screen; everything else floats over it as glass

The main content of a page (the word list on /words, the review card, a reading view) fills the whole screen, edge to edge and behind the safe areas. It can move across the whole space: a swiped card slides anywhere, a list scrolls under everything.

Navigation, help and hint strips, the debug chat, toolbars and menus are translucent glass overlays floating over the content. They take no layout space.

- **Reserve, don't push.** A resting layout gets just enough padding (or scroll-padding) that content at rest isn't covered by an overlay: the first and last list rows can still scroll fully into view. Content in motion (a swiped card, a scrolled list) passes under the glass and shows through it.
- **Glass.** A low-alpha background in the page's own colour, e.g. `oklch(from var(--background) l c h / 0.6)` or a fixed oklch with alpha, plus `backdrop-filter: blur(12px) saturate(1.4)` and a 1px hairline edge. Every colour is oklch.
- **Safe areas.** Overlays pad themselves with `env(safe-area-inset-*)`; the content runs underneath, behind the notch and the home indicator.
  - On the iPhone home-screen app the status bar is see-through (`statusBarStyle: "black-translucent"` with `viewportFit: "cover"`, app/layout.tsx). Without it iOS keeps a solid bar and `env(safe-area-inset-top)` is 0. The bar's clock is always white, so `.lk-statusbar` puts a darker glass band behind it (home-screen app only). iOS keeps the style an installed app had when it was added: a change reaches it only after removing it from the home screen and adding it again ([WebKit bug 260508](https://bugs.webkit.org/show_bug.cgi?id=260508)); a relaunch is not enough. Next.js emits only `mobile-web-app-capable`, so `apple-mobile-web-app-capable` is added through `metadata.other`.
  - In landscape the body pads the notch sides. Full-width bars step back out over them (`.lk-header-bleed`, `.lk-nav-overlay`) and pad their own controls.
- **Room.** Optional overlays (help, hints) show only when there is room: a tall enough viewport, the on-screen keyboard closed. Otherwise they hide rather than squeeze the content.
- **Input-aware hints.** Touch hints show only for touch, keyboard hints only for a hardware keyboard; on hybrid devices, the input used last decides.

## Edge gestures

The owner, 2026-11-04 (Slack): "需要注意移动端，特别是安卓。经常右边整一条边的往左滑动都会识别为页面级别的返回键。"
On Android with gesture navigation, a sideways drag that starts on either
screen edge is the system's Back; iOS has its own edge swipe back. A web page
can't cancel either one.

- **Never rely on a gesture that starts at a screen edge.** Every swipe
  (swipe to grade on /words and /reader) must be comfortable from inside: the
  text a finger grabs sits clear of the edge strip, and the travel needed (one
  or two levels of `a`) fits between the strip and the far side.
- **Edge handles are tap targets inset from the edge,** never drag handles
  that live on it.
- **The strip's width** is `--lk-edge-gesture` in `app/globals.css` (24px,
  Android's default back strip; no `env()` reports it, safe-area insets cover
  only the notch). `--lk-edge-l` / `--lk-edge-r` add the safe area. It is a
  UI internal, not a user setting.
- **A stolen gesture is a cancel, not a lift.** When the system takes the
  touch (`pointercancel`, `touchcancel`) or the page is hidden or left
  mid-drag (`visibilitychange`, `pagehide`, `popstate`, `blur`:
  `lib/page-leave.ts`), the slip goes home and nothing is graded.
- **An accidental Back loses nothing.** Grades are queued on the device the
  moment they are given; positions waiting on a debounce (/words' anchor, the
  /reader anchor) are written at once on Back, hide and leave, so coming back
  opens at the same word.

## As little visual nesting as possible

The owner, 2026-11-03 18:32 JST: "尽量减少视觉上的嵌套数量". Avoid boxes in
boxes, borders in borders, cards in cards. One level of framing at most:

- When an outer frame appears (a glass panel, a sheet), what sits inside it
  drops its own border and background instead of drawing a second frame. The
  chat bar's input, for example, loses its box while the focused glass panel
  around the log and input is showing (keeping the border width, transparent,
  so nothing shifts).
- Separate things with space, alignment, weight and colour before reaching
  for a border.
- Text sits directly on the page or on one glass layer, never on a card on a
  card.

## No fixed numbers for users

The owner, 2026-11-03 (Slack): "不要给用户规划任何死数字，不同的用户应该有他们自己的数字".
A number shown to or imposed on a user (a daily amount, a chunk size, a
goal, a pace) comes from that user: their goal and target date, their
measured speed and history. We never pick a constant like "3 chunks a day"
or "250 words a chunk" for everyone.

The only built-in numbers are common knowledge that holds at every scale:
the 95% reading-coverage line, the 60% general pass mark, the 1–3 s a person
takes to react to information of a given size. When a user has no data yet,
start from such a rule (e.g. a reading chunk = what they read in 1–3 minutes
at their measured speed) and adapt as data comes in.

## No special cases for any language

The owner, 2026-11-03 19:05 JST: "你不要对任何语言有各种特殊处理". Code is
generic; language specifics (elision and clitic rules, apostrophe variants,
inflection folds, lemma maps, capitalisation and name rules, segmentation
hints, frequency lists) live in per-language **data files** loaded by
language code and fed to one engine (Intl.Segmenter, Unicode
normalisation). No `if (lang === "…")` branches; a new language is added by
adding data, not code. Features shown for "a language" (add all, frequency
bands, …) exist for every language the data supports.

## Chrome steps back while you read (proposal, 2026-11-03)

Owner: "梳理一下缩小规则". Proposed rule set (decisions A–D open in Slack); today's
behaviour per surface is summarised in the Slack thread of 2026-11-03.

- **One intent signal.** The person's own scroll toward more content means
  reading: chrome steps back. A deliberate scroll back, reaching the top, a
  route change, or a tap on the reduced form brings it back. Stopping is not
  a signal. Programmatic scrolls (follow-the-line, anchoring), scrolls inside
  overlays (chat log, tree, sheets) and horizontal gestures (swipe to grade)
  never count; tell user scrolls from input events.
- **Three levels: full → reduced → hidden.** Reduced always leaves something
  to tap back (the island's capsule, the chat's mark and mic, one line).
  Hidden only for the keyboard and modal sheets.
- **The keyboard:** everything except the surface being typed into hides; that
  one lifts above the keyboard. One shared detector (visual viewport).
- **Room as a share of the screen,** not pixels: optional overlays (help, tips,
  frontier lines) go first when the content would lose most of the screen.
- **The person owns open/minimized** for the chat (and the sidebar);
  automatic reduction only moves an open chat between full and last line.
- **Height decides, not width:** a short screen (phone in landscape) is a
  reading surface: island as capsule, top strips reduced, no sidebar over
  the content.
- **The reserve follows the level:** `--lk-bottom-reserve` equals what the
  overlay covers at its current level.
- **Words:** "reduced" (automatic) and "minimized" (the person's choice) are
  different states; don't call both "compact".
- **/reader:** window scroll, no inner scroller; island as capsule (owner
  decision) and top strip reduced while reading; play pill at the thumb;
  playback follow and swipe-to-grade never change the chrome.

### Accessibility and contrast

- Text on glass must keep at least 4.5:1 contrast against the worst plausible content behind it. Use the page ink colour plus a halo (`text-shadow` in the page colour), and test over light and dark content.
- Where `backdrop-filter` is unsupported, or the user prefers reduced transparency (`prefers-reduced-transparency: reduce`), fall back to a near-opaque background (alpha ≈ 0.9).
- Overlays never trap focus unless they are modal. Modals (pairing, sheets) say so with `role="dialog"`, `aria-modal`, Escape to close.
- Motion respects `prefers-reduced-motion`.
- Tap targets on overlays are at least 40px.
