// Chrome steps back while you read (docs/design-principles.md, the /read
// rules): his own scroll toward more content reduces the top strip and keeps
// the bottom island as its capsule; a deliberate scroll back, reaching the
// top, or a tap on the reduced form brings the strip back. Programmatic
// scrolls (follow, auto-advance, restore) and horizontal swipes never count:
// the reader feeds only scrolls made while his own input is active (touch,
// wheel, scroll keys). Pure, so the rules are unit-tested
// (unit/read-reader-chrome.test.ts).

export interface ChromeState {
  /** The top strip is reduced to one line. */
  reduced: boolean;
  /** Upward travel of his own scroll since the strip was last reduced, px. */
  back: number;
}

export const CHROME_FULL: ChromeState = { reduced: false, back: 0 };

/**
 * What counts as a deliberate scroll back: a share of the screen's height,
 * not a pixel count, so it is the same gesture on every screen.
 */
export const BACK_SHARE = 0.12;
/** Within this share of the screen's height from the top, the strip is full. */
export const TOP_SHARE = 0.02;

export type ChromeEvent =
  /** His own scroll moved the page by dy (down = +) to y, on a screen vh tall. */
  | { type: "scroll"; dy: number; y: number; vh: number }
  /** A tap on the reduced strip. */
  | { type: "tap" };

export function chromeStep(s: ChromeState, e: ChromeEvent): ChromeState {
  if (e.type === "tap") return CHROME_FULL;
  if (e.y <= e.vh * TOP_SHARE) return s.reduced || s.back ? CHROME_FULL : s;
  if (e.dy > 0) return s.reduced && s.back === 0 ? s : { reduced: true, back: 0 };
  if (e.dy < 0 && s.reduced) {
    const back = s.back - e.dy;
    return back >= e.vh * BACK_SHARE ? CHROME_FULL : { reduced: true, back };
  }
  return s;
}

/**
 * His own input is driving the page's scroll. Starts on touchstart (one
 * finger), wheel and the scroll keys; ends when the page is still again
 * (scrollend, or `quietMs` without a scroll on browsers without it).
 */
export const SCROLL_KEYS: ReadonlySet<string> = new Set([
  "ArrowDown",
  "ArrowUp",
  "PageDown",
  "PageUp",
  "Home",
  "End",
]);
