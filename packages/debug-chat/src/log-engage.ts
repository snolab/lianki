/**
 * When the chat's history takes the pointer (owner, 2026-11-05 13:00 JST,
 * Mac Chrome on /books: "the history is glass: a wheel or a click over it
 * should reach the page unless I am in the chat").
 *
 * At rest the history is fully click-through (no pointer on the log or its
 * lines): a wheel over it scrolls the page, a click lands on the page under
 * it. It is "engaged", and takes the pointer (log-surface.ts LOG_TOUCH: a
 * wheel or a drag scrolls the history, a press on a line selects its text),
 * while:
 *
 *   - the input is in use (focused, or the + menu / its file picker up), or
 *   - `held`: a press-and-hold on the history (HOLD_MS, still within
 *     HOLD_SLOP_PX) engaged it and selected the line under it ("rest": the
 *     log keeps its resting height, so the line stays under the finger), or
 *     a press on the history while the input was in use ("open": a press on
 *     a line blurs the input, and the log would fold to 3 lines under the
 *     drag; it stays open, glass and all), or a selection is open in the
 *     chat. It lasts until a press lands outside the chat.
 *
 * The mic being on does not engage it (owner, 2026-11-10, iPhone on
 * /reader): with the input not focused, a drag over the history scrolls the
 * page underneath; only the bar, its buttons and cards, links, or the
 * focused or full-screen chat take a touch. A hold still engages it.
 *
 * The press-and-hold is seen at the document (the log takes no events at
 * rest): a pointerdown inside the log's box starts one timer, a move past
 * the slop, the release or a scroll cancels it. Nothing polls. This file is
 * the decisions, pure; the DOM glue is log-hold-dom.ts.
 */
import { FENCE_SELECTOR } from "./select-fence";
import { inputInUse } from "./typing-glass";

/** The platform's long-press duration (iOS and Android are both ~500 ms). */
export const HOLD_MS = 500;
/** A hold moving further than this is a drag or a scroll, not a hold. */
export const HOLD_SLOP_PX = 10;

/** Set on <html> while a touch hold may be under way, and for the rest of a fired one. */
export const HOLD_ATTR = "data-lk-chat-holding";

/**
 * While HOLD_ATTR is up, the page outside the chat has no text selection and
 * no touch callout (the platform's own long-press would select it, or open a
 * link preview, under the finger). Same reach as select-fence.ts FENCE_CSS:
 * not the chat, not in it, not holding it, not an embed's shadow host.
 */
export const HOLD_CSS = `html[${HOLD_ATTR}] body *:not(${FENCE_SELECTOR}):not(${FENCE_SELECTOR} *):not(:has(${FENCE_SELECTOR})):not([data-lk-chat-host]){-webkit-user-select:none!important;user-select:none!important;-webkit-touch-callout:none!important}`;

/** The history takes the pointer: wheel and drag scroll it, its lines select. */
export function logEngaged(s: {
  typing: boolean;
  plusMenu?: boolean;
  micActive: boolean;
  held: Held;
}): boolean {
  return inputInUse(s) || !!s.held;
}

/** How the history is held (see above): not, at its resting height, or open. */
export type Held = false | "rest" | "open";

/**
 * The chat counts as typing for the log's height, the glass and the panel's
 * opacity: the input focused, or held open after a press on the history
 * while it was (the press took the focus away).
 */
export const typingLook = (typing: boolean, held: Held) => typing || held === "open";

type Rect = { left: number; top: number; right: number; bottom: number };

const inside = (r: Rect, x: number, y: number) =>
  x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

/**
 * Whether this pointerdown starts a hold: the history at rest (not engaged:
 * engaged, it takes the press itself), shown (`log` is its box, null when
 * hidden or empty), the primary button (a mouse's left, any touch or pen),
 * at a point inside its box.
 */
export function holdStarts(d: {
  engaged: boolean;
  log: Rect | null;
  button: number;
  x: number;
  y: number;
}): boolean {
  if (d.engaged || !d.log || d.button !== 0) return false;
  if (d.log.right - d.log.left <= 0 || d.log.bottom - d.log.top <= 0) return false;
  return inside(d.log, d.x, d.y);
}

/** Whether the pointer is still within the hold's slop of where it pressed. */
export function holdStill(from: { x: number; y: number }, at: { x: number; y: number }, slop = HOLD_SLOP_PX) {
  return Math.hypot(at.x - from.x, at.y - from.y) <= slop;
}

/**
 * Which line the hold selects: the one whose box holds the point, else the
 * nearest by height (the point may fall between two lines). -1 for none.
 */
export function lineAt(rows: readonly Rect[], x: number, y: number): number {
  const hit = rows.findIndex((r) => inside(r, x, y));
  if (hit !== -1) return hit;
  let best = -1;
  let gap = Number.POSITIVE_INFINITY;
  rows.forEach((r, i) => {
    const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    if (d < gap) {
      best = i;
      gap = d;
    }
  });
  return best;
}

/**
 * `held` after a pointerdown: dropped by a press outside the chat (the page,
 * outside the box); a press on the history while the input is in use or the
 * mic on (`busy`) holds it open; else kept as it was (a hold firing, or a
 * selection in the chat, sets "rest").
 */
export function heldAfterPress(
  held: Held,
  press: { inChat: boolean; inLog: boolean; busy: boolean },
): Held {
  if (!press.inChat) return false;
  if (press.inLog && press.busy) return "open";
  return held;
}
