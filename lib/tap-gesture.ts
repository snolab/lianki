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
