/**
 * Device preferences for the Gantt chart view (packages/debug-chat/src/GanttFull.tsx):
 * localStorage `lk:gantt-hide-done`, defaults to true.
 *
 * Owner's specification (2026-11-15):
 * Hide completed tasks by default; allow toggling to show them.
 * Switch state is stored in localStorage `lk:gantt-hide-done`.
 * Multiple options use a segmented control, not individual pills or checkboxes.
 */

export const GANTT_HIDE_DONE_KEY = "lk:gantt-hide-done";

/**
 * Reads whether completed tasks should be hidden in the Gantt chart.
 * Defaults to true.
 */
export function readGanttHideDone(): boolean {
  if (typeof window === "undefined" || !window.localStorage) return true;
  try {
    const raw = window.localStorage.getItem(GANTT_HIDE_DONE_KEY);
    return raw === null ? true : raw === "true";
  } catch {
    return true;
  }
}

/**
 * Writes the hide-done preference to localStorage.
 */
export function writeGanttHideDone(hide: boolean): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(GANTT_HIDE_DONE_KEY, hide ? "true" : "false");
  } catch {}
}
