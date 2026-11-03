/**
 * Back closes an overlay (a sheet, a drawer, a dialog) instead of leaving the
 * page (docs/ui-state.md, "Back closes an overlay"). Owner, 2026-11-03: the
 * browser's or the phone's back with a word's sheet open folds the sheet.
 *
 * While the overlay is open, one history entry of its own sits on top: the
 * same URL, the same state plus a marker (`__lkBack`). Next.js's patched
 * pushState passes a state that carries `__NA` straight through, so its
 * router keeps its tree and sees no new URL.
 *
 * - back (popstate off our entry): the overlay closes — `onBack`.
 * - closed by its own UI: our entry is consumed with one history.back(),
 *   only if it is still the current entry (a router.push since then leaves
 *   history alone).
 * - opened again before that back has landed: the push waits for it, so the
 *   late back never pops the new entry.
 * - a reload with the overlay open leaves a marked entry behind and nothing
 *   reopens from it (an overlay is not URL state): `dropOrphan` strips the
 *   marker, so it never counts as an open overlay. That entry stays, so one
 *   back press after such a reload changes nothing on screen.
 */

export const BACK_KEY = "__lkBack";

export type HistoryLike = {
  readonly state: unknown;
  readonly length: number;
  pushState(data: unknown, unused: string): void;
  replaceState(data: unknown, unused: string): void;
  back(): void;
};
export type BackWinLike = {
  history: HistoryLike;
  location: { readonly href: string };
  addEventListener(type: "popstate", fn: () => void): void;
  removeEventListener(type: "popstate", fn: () => void): void;
};

type Marked = Record<string, unknown>;
const markOf = (state: unknown) =>
  state && typeof state === "object" ? (state as Marked)[BACK_KEY] : undefined;

/** Tokens of the overlays open now; any other marker is an orphan. */
const live = new Set<string>();
/** Per window: the pushes waiting for a back that has not landed yet. */
const waiting = new WeakMap<BackWinLike, (() => void)[]>();
let seq = 0;

/** Strips a marker no open overlay owns (left behind by a reload). */
export function dropOrphan(win: BackWinLike) {
  const s = win.history.state;
  const m = markOf(s);
  if (m === undefined || live.has(String(m))) return;
  const { [BACK_KEY]: _, ...rest } = s as Marked;
  win.history.replaceState(rest, "");
}

/**
 * Opens one overlay's history entry now. `onBack` runs when back leaves it;
 * call the returned `close` when the overlay closes any other way (it is
 * safe to call after `onBack`, and more than once).
 */
export function openBackToClose(win: BackWinLike, onBack: () => void): () => void {
  const token = `${Date.now().toString(36)}.${++seq}`;
  let pushed = false;
  let closed = false;
  let at = { href: "", length: 0 };

  const push = () => {
    if (closed) return;
    dropOrphan(win);
    const s = win.history.state;
    win.history.pushState({ ...(s && typeof s === "object" ? s : {}), [BACK_KEY]: token }, "");
    at = { href: win.location.href, length: win.history.length };
    pushed = true;
  };
  // Our entry is still the one shown. The marker is the proof; the URL and
  // the length stand in if Next.js rewrote the state (its replaceState after
  // a tree change drops keys it does not know).
  const current = () =>
    markOf(win.history.state) === token ||
    (win.location.href === at.href && win.history.length === at.length);

  const onPop = () => {
    // The current state, not the event's: a push made inside this same
    // popstate (a reopen waiting for a back) is already on top.
    if (!pushed || markOf(win.history.state) === token) return;
    pushed = false;
    close();
    onBack();
  };

  const close = () => {
    if (closed) return;
    closed = true;
    live.delete(token);
    win.removeEventListener("popstate", onPop);
    if (!pushed) return;
    pushed = false;
    if (!current()) return;
    if (!waiting.has(win)) {
      waiting.set(win, []);
      const landed = () => {
        win.removeEventListener("popstate", landed);
        const next = waiting.get(win) ?? [];
        waiting.delete(win);
        for (const run of next) run();
      };
      win.addEventListener("popstate", landed);
    }
    win.history.back();
  };

  live.add(token);
  win.addEventListener("popstate", onPop);
  const queue = waiting.get(win);
  if (queue) queue.push(push);
  else push();
  return close;
}
