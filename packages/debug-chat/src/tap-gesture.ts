/**
 * One tap or two (the debug chat's grip): a single tap acts only once
 * `delayMs` pass without a second; a second tap inside that window cancels it
 * and acts as a double tap. Timers are injected for tests.
 */
export const DOUBLE_TAP_MS = 280;

export function createTapper(d: {
  onSingle: () => void;
  onDouble: () => void;
  delayMs?: number;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}) {
  const setTimer = d.setTimer ?? ((f, ms) => setTimeout(f, ms));
  const clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let waiting: unknown = null;
  return {
    tap() {
      if (waiting !== null) {
        clearTimer(waiting);
        waiting = null;
        return d.onDouble();
      }
      waiting = setTimer(() => {
        waiting = null;
        d.onSingle();
      }, d.delayMs ?? DOUBLE_TAP_MS);
    },
    /** Drop a single tap still waiting (unmount). */
    cancel() {
      if (waiting !== null) clearTimer(waiting);
      waiting = null;
    },
  };
}

/** How long after a drag ends its click is still "the click that ended a drag". */
export const DRAG_CLICK_MS = 400;

/**
 * Tells the click that ends a drag from a real tap. The flag is cleared by
 * the next pointerdown and expires after DRAG_CLICK_MS, so a browser that
 * sends no click after a touch drag (iOS) never swallows the next tap.
 */
export function createDragFlag(now: () => number = Date.now) {
  let endedAt: number | null = null;
  return {
    /** A press starts: whatever came before is over. */
    down() {
      endedAt = null;
    },
    /** A press that moved has ended. */
    dragEnded() {
      endedAt = now();
    },
    /** For the click that follows: was it the end of a drag? (Read once.) */
    wasDrag() {
      const d = endedAt !== null && now() - endedAt < DRAG_CLICK_MS;
      endedAt = null;
      return d;
    },
  };
}
