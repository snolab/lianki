/**
 * Copying a chat line (owner, 2026-11-05: "这里复制不了" on the iPhone PWA).
 *
 * The chat box is click-through (`pointer-events: none` on the section, so
 * the page under it stays usable), and the log inherited it: on iOS a
 * long-press on text that does not take the pointer never selects it, so
 * there was no Copy. Each line's own text now takes the pointer and is
 * selectable (LINE_SELECTABLE); the empty space around it stays
 * click-through. Long-press (or a mouse drag) and the platform's Copy do
 * the rest; the per-line copy button was dropped (owner, 2026-11-05 02:00 JST).
 */

/**
 * The classes that make a line's text selectable: it takes the pointer
 * (its parents are click-through), `user-select: text` (WebKit's prefixed
 * one too) and the iOS long-press callout back on, should a host or a
 * parent turn either off.
 */
export const LINE_SELECTABLE =
  "pointer-events-auto select-text [-webkit-user-select:text] [-webkit-touch-callout:default]";
