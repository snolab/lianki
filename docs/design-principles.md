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

### Accessibility and contrast

- Text on glass must keep at least 4.5:1 contrast against the worst plausible content behind it. Use the page ink colour plus a halo (`text-shadow` in the page colour), and test over light and dark content.
- Where `backdrop-filter` is unsupported, or the user prefers reduced transparency (`prefers-reduced-transparency: reduce`), fall back to a near-opaque background (alpha ≈ 0.9).
- Overlays never trap focus unless they are modal. Modals (pairing, sheets) say so with `role="dialog"`, `aria-modal`, Escape to close.
- Motion respects `prefers-reduced-motion`.
- Tap targets on overlays are at least 40px.
