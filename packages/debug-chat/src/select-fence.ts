/**
 * A selection started in the chat stays in the chat (owner, 2026-11-05 11:05
 * JST, Mac Chrome: a drag from a chat line that went past the box selected
 * half the page).
 *
 * Two parts, both event-driven (select-fence-dom.ts wires them):
 *
 *   - while a selection is being made from a chat line (a press on a line,
 *     or a selection anchored in the chat, as iOS's handles leave one),
 *     <html> carries FENCE_ATTR and FENCE_CSS turns everything outside the
 *     chat non-selectable, so the drag has nothing out there to take;
 *   - on every `selectionchange`, a selection anchored in the chat whose
 *     focus has left it gets its focus put back at the chat's nearest edge.
 *
 * This file is the decisions, pure; the DOM glue is in select-fence-dom.ts.
 */

/** The chat's box: the fence a selection started in it stays inside. */
export const FENCE_SELECTOR = "[data-debug-chat]";

/** Where a line's text is selectable (copy-line.ts LINE_SELECTABLE carries `select-text`). */
export const SELECTABLE_SELECTOR = ".select-text";

/** Set on <html> while a selection is being made in the chat. */
export const FENCE_ATTR = "data-lk-chat-selecting";

/**
 * Outside the chat, nothing selectable while FENCE_ATTR is up: every element
 * that is not the chat, not in it, and does not hold it (its ancestors stay
 * as they are, or the chat inside them would go too), and not an embed's
 * shadow host (its chat is inside). The chat's lines keep their text.
 */
export const FENCE_CSS = `html[${FENCE_ATTR}] body *:not(${FENCE_SELECTOR}):not(${FENCE_SELECTOR} *):not(:has(${FENCE_SELECTOR})):not([data-lk-chat-host]){-webkit-user-select:none!important;user-select:none!important}
html[${FENCE_ATTR}] ${FENCE_SELECTOR} ${SELECTABLE_SELECTOR}{-webkit-user-select:text;user-select:text}`;

/** Which way the pointer left the chat, when it says so. */
export type Hint = "before" | "after" | undefined;

/**
 * Where the focus goes back to: the chat's first selectable text ("start"),
 * its last ("end"), or nowhere (null: it is inside).
 *
 * `cmp` is the focus against the chat's contents (Range.comparePoint: -1
 * before them, 0 inside, 1 after). A pointer that left over the top or the
 * bottom (`hint`) decides over document order: the chat is a fixed box, so
 * page text above it on the screen can come after it in the document.
 */
export function clampSide(cmp: number, hint?: Hint): "start" | "end" | null {
  if (cmp === 0) return null;
  if (hint) return hint === "before" ? "start" : "end";
  return cmp < 0 ? "start" : "end";
}

type Box = { top: number; bottom: number };

/**
 * Which way a pointer at `y` has gone: above or below the chat, else above
 * or below the line the selection started on; beside it, no say.
 */
export function pointerHint(y: number, fence: Box, anchor?: Box): Hint {
  if (y < fence.top) return "before";
  if (y > fence.bottom) return "after";
  if (!anchor) return undefined;
  if (y < anchor.top) return "before";
  if (y > anchor.bottom) return "after";
  return undefined;
}

/**
 * FENCE_ATTR is up while a line is pressed, and after it while the selection
 * it made (anchored in the chat, not collapsed) is open, as iOS's handles go
 * on moving it with no press of their own. `armed` is the press on a line
 * that started it; a press anywhere outside the chat disarms it at once, so
 * the page's own selection can start before the chat's one is gone.
 */
export function fenceUp(s: {
  armed: boolean;
  pressed: boolean;
  anchoredInChat: boolean;
  collapsed: boolean;
}) {
  return s.armed && (s.pressed || (s.anchoredInChat && !s.collapsed));
}
