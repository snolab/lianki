/**
 * Which islands are overridden on this page right now (docs/dev-hot-islands.md).
 * Plain JS, no React: Island.tsx reads it, the loader writes it, DebugEval
 * sets the grant. Nothing here touches the network.
 */
import type { ComponentType } from "react";

/** A hot-loaded island: its component and the build it came from. */
export type Override = { C: ComponentType<Record<string, unknown>>; rev: string };

export type IslandStore = ReturnType<typeof createIslandStore>;

/** Browser timers must be called unbound (`timers.clearTimeout(...)` throws "Illegal invocation"). */
const realTimers = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (t: ReturnType<typeof setTimeout> | undefined) => clearTimeout(t),
};

export function createIslandStore(timers = realTimers) {
  const overrides = new Map<string, Override>();
  const listeners = new Set<() => void>();
  let until: number | null = null;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  /** The live-view pointer's expiry (docs/live-view.md): a second, independent permission. */
  let liveUntil: number | null = null;
  let liveExpiry: ReturnType<typeof setTimeout> | undefined;
  const any = () => until !== null || liveUntil !== null;
  const emit = () => {
    for (const l of listeners) l();
  };
  const store = {
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    get: (name: string) => overrides.get(name),
    names: () => [...overrides.keys()],
    /** Whether this page may show hot islands: a live code-run grant, or a verified live-view pointer. */
    granted: any,
    /**
     * The code-run grant: until when it lasts, or null for none. When it lapses
     * (one local timeout) or is withdrawn, every island goes back to built in.
     */
    setGrant(next: number | null, now = Date.now()) {
      const v = next !== null && next > now ? next : null;
      if (v === until) return;
      timers.clearTimeout(expiry);
      until = v;
      const left = v === null ? 0 : v - now;
      if (v !== null && left < 2 ** 31 - 1)
        expiry = timers.setTimeout(() => store.setGrant(null), left);
      if (!any()) overrides.clear();
      emit();
    },
    /**
     * The live-view pointer (signed by the dev key, verified on the page): until
     * when it lasts, or null. Independent of the code-run grant: either one is enough.
     */
    setLive(next: number | null, now = Date.now()) {
      const v = next !== null && next > now ? next : null;
      if (v === liveUntil) return;
      timers.clearTimeout(liveExpiry);
      liveUntil = v;
      const left = v === null ? 0 : v - now;
      if (v !== null && left < 2 ** 31 - 1)
        liveExpiry = timers.setTimeout(() => store.setLive(null), left);
      if (!any()) overrides.clear();
      emit();
    },
    /** Install or replace these islands only; the others keep their component (no remount). */
    put(next: Record<string, Override>) {
      if (!any()) return;
      for (const [k, o] of Object.entries(next)) overrides.set(k, o);
      emit();
    },
    /** One island back to built in (its override failed). */
    drop(name: string) {
      if (overrides.delete(name)) emit();
    },
    /** Every island back to built in. */
    clear() {
      if (!overrides.size) return;
      overrides.clear();
      emit();
    },
  };
  return store;
}

/** The page's one store. */
export const islandStore = createIslandStore();
