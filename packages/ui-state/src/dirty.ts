/**
 * The page's "unsaved work" registry (lib/page-dirty.ts pageIsDirty): a
 * component that holds something a reload or leaving would throw away (an
 * enrolment under way, a grade in flight, a swipe mid-gesture) registers a
 * check while it does, and calls notifyDirty() when its answer may have
 * changed.
 *
 * On globalThis (DIRTY_KEY), like the UI stores, so the chat widget's
 * hot-swapped bundle and the app share one registry. No imports from the app:
 * the leave guard (app/components/LeaveGuard.tsx) installs how "dirty" is
 * judged and its message (setLeaveGuard), and confirmLeave() uses them.
 */

/**
 * Why the page asks: "reload" (a debug device picking up a deploy: strict) or
 * "leave" (the leave guard's confirm: unsaved content only, no false alarms).
 */
export type DirtyMode = "reload" | "leave";
/** A check: true while the page holds something a reload (or leaving) would lose. */
export type DirtyCheck = (mode: DirtyMode) => boolean;

/** What the mounted leave guard judges with, and the confirm it shows. */
export type LeaveGuard = { isDirty: () => boolean; message: string };

/** globalThis key of the registry. */
export const DIRTY_KEY = "__lkDirty";

type Registry = { checks: Set<DirtyCheck>; listeners: Set<() => void>; guard?: LeaveGuard };

function registry(): Registry {
  const g = globalThis as unknown as Record<string, Registry | undefined>;
  return (g[DIRTY_KEY] ??= { checks: new Set(), listeners: new Set() });
}

/** Add a check; returns its unregister (which notifies, as the answer may now be "clean"). */
export function registerDirtyCheck(fn: DirtyCheck): () => void {
  const r = registry();
  r.checks.add(fn);
  notifyDirty();
  return () => {
    if (r.checks.delete(fn)) notifyDirty();
  };
}

/** True when any registered check says so (a check that throws counts as dirty). */
export function anyDirtyCheck(mode: DirtyMode = "reload"): boolean {
  for (const fn of registry().checks) {
    try {
      if (fn(mode)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/** A check's answer may have changed: tell whoever waits for a clean page. */
export function notifyDirty(): void {
  for (const f of [...registry().listeners]) {
    try {
      f();
    } catch {}
  }
}

/** Called on every notifyDirty(); returns an unsubscribe. */
export function onDirtyNotify(f: () => void): () => void {
  const r = registry();
  r.listeners.add(f);
  return () => void r.listeners.delete(f);
}

/** Install the leave guard's judgement and message; returns its removal. */
export function setLeaveGuard(g: LeaveGuard): () => void {
  const r = registry();
  r.guard = g;
  return () => {
    if (r.guard === g) r.guard = undefined;
  };
}

/**
 * Before switching away from something (a tab, a panel, a route pushed by
 * code): true when it may go ahead — the page is clean, or he confirmed.
 * Without a guard mounted, only the registry's checks count.
 */
export function confirmLeave(ask: (message: string) => boolean = (m) => globalThis.confirm(m)): boolean {
  const g = registry().guard;
  const dirty = g ? g.isDirty() : anyDirtyCheck("leave");
  if (!dirty) return true;
  return ask(g?.message ?? "You have unsaved changes. Leave anyway?");
}
