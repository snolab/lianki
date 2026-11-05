/**
 * An example cell follows the word being read aloud (owner, 2026-11-05 03:11
 * JST): while the voice reads a long example, the cell (Glance in
 * app/(app)/words/WordsClient.tsx) scrolls so the lit word (.lk-ex-spoken,
 * lib/words/spoken-word.ts) stays in view.
 *
 * - Driven by the highlight itself: MarkedExample tells the follower each time
 *   the lit word moves (`spokenMoved`), after it is painted — no timers, no
 *   polling.
 * - It scrolls only when the word would leave the visible part, and then the
 *   way #528 places the card's word (lib/words/centre-in.ts `aimAt`): whole
 *   lines on a wrapped example, centred on a one-line one, RTL-aware. The
 *   cell scrolls, never the page.
 * - A touch scroll (or wheel) of the person's own on the cell holds the
 *   follow until the reading ends.
 * - When the reading ends (the end, a pause or stop, the next card), the cell
 *   goes back to where it started: the card's word, as #528 places it.
 */
import {
  aimAt,
  inViewIn,
  scrollToAim,
  type AimBox,
  type AimInner,
  type Rects,
} from "@/lib/words/centre-in";

type Listen = {
  addEventListener(type: string, fn: () => void, o?: AddEventListenerOptions): void;
  removeEventListener(type: string, fn: () => void): void;
};
export type FollowBox = AimBox & Listen;

/** What the cell tells its follower, and is told back. */
export type FollowCell = {
  /** The content inside the cell, moving as it scrolls. */
  inner(): AimInner | null;
  wrap: boolean;
  lines: number;
  /** A line's height, px (wrapped cells). */
  lh(): number;
  rtl(): boolean;
  smooth(): boolean;
  /** Where the cell rests when nothing is read: the card word's aim (0: unscrolled). */
  home(): number;
  /** Reading starts (true) or ends (false) in this cell. */
  following(on: boolean): void;
};

export type Follower = {
  /** The lit word moved to `el` (painted). */
  word(el: Rects): void;
  /** The cell's layout changed under the lit word (it unclamped, resized). */
  relayout(): void;
  /** The reading ended: back home. */
  end(): void;
  readonly on: boolean;
  readonly held: boolean;
};

const HOLD_EVENTS = ["touchmove", "wheel"] as const;

export function spokenFollower(box: FollowBox, cell: FollowCell): Follower {
  let on = false;
  let held = false;
  let last: Rects | null = null;
  const hold = () => {
    held = true;
  };
  const check = () => {
    const i = cell.inner();
    if (!on || held || !last || !i) return;
    if (inViewIn(box, last, cell.wrap)) return;
    const rtl = cell.rtl();
    scrollToAim(
      box,
      aimAt(box, i, last, cell.wrap, cell.lines, cell.lh(), rtl),
      cell.wrap,
      rtl,
      cell.smooth(),
    );
  };
  return {
    word(el) {
      last = el;
      if (!on) {
        on = true;
        for (const t of HOLD_EVENTS) box.addEventListener(t, hold, { passive: true });
        cell.following(true);
      }
      check();
    },
    relayout: check,
    end() {
      if (!on) return;
      on = false;
      held = false;
      last = null;
      for (const t of HOLD_EVENTS) box.removeEventListener(t, hold);
      scrollToAim(box, cell.home(), cell.wrap, cell.rtl(), cell.smooth());
      cell.following(false);
    },
    get on() {
      return on;
    },
    get held() {
      return held;
    },
  };
}

// ── Which cell a lit word is in ────────────────────────────────────────────

/** The attribute a following cell carries; its follower is registered under it. */
export const FOLLOW_ATTR = "data-ex-follow";
const cells = new WeakMap<object, Follower>();
export function registerFollower(box: object, f: Follower) {
  cells.set(box, f);
  return () => {
    if (cells.get(box) === f) cells.delete(box);
  };
}

type Closest = Rects & { closest(sel: string): object | null };

/**
 * The lit word moved to `el` (null: none lit any more, in this example).
 * Tells the cell it is in, and ends the follow of the cell before (`prev`)
 * when it is another or none. Returns the cell now following.
 */
export function spokenMoved(el: Closest | null, prev: Follower | null): Follower | null {
  const box = el?.closest(`[${FOLLOW_ATTR}]`);
  const f = (box && cells.get(box)) || null;
  if (prev && prev !== f) prev.end();
  if (el && f) f.word(el);
  return f;
}
