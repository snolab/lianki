/**
 * A small per-isolate cache for a whole-table snapshot read from D1: the
 * feature flags (lib/flags-store.ts) and the config values
 * (lib/config-store.ts) use it.
 *
 * - A snapshot is kept for `ttlMs`; a change written elsewhere reaches this
 *   isolate within that window, no deploy.
 * - Concurrent misses share one read. A read that started a window ago or more
 *   is not joined, and a read held past the window is not used: no snapshot
 *   older than the window is ever returned.
 * - A load that returns null (no D1 here) or throws gives the `fallback` for
 *   that call and is not cached, so the next call tries again. Flags fall back
 *   to all-off (fail closed), config to the registry defaults.
 * - `clear()` forgets the snapshot; a read that started before it never fills
 *   the cache (a generation counter).
 *
 * The state lives on globalThis under `slot`: the build gives route handlers
 * and page rendering each their own copy of a module, and module-level state
 * was two caches up to a window apart (qa-yt-songs, 2026-11-09).
 */

interface SnapshotState<T> {
  cache: { at: number; values: T } | null;
  /** The shared read, and when it started (its snapshot is at least that old). */
  inflight: { at: number; p: Promise<T | null> } | null;
  /** Bumped by every clear, so a read that started before it never fills the cache. */
  generation: number;
}

export interface SnapshotCache<T> {
  /** The snapshot, at most `ttlMs` old; `fallback()` when it cannot be read. */
  read(load: () => Promise<T | null>, now?: () => number): Promise<T>;
  /** Forget the cached snapshot (after a write here; and between unit tests). */
  clear(): void;
}

export function snapshotCache<T>(opts: {
  /** The globalThis property that holds the state. */
  slot: string;
  ttlMs: number;
  /** What a failed or impossible read returns. */
  fallback: () => T;
  /** A copy handed to each caller, so none can change the cached one. */
  copy: (v: T) => T;
  /** Log event prefix: "<event>.read-stale", "<event>.read-failed". */
  event: string;
}): SnapshotCache<T> {
  const g = globalThis as unknown as Record<string, SnapshotState<T> | undefined>;
  const state: SnapshotState<T> = (g[opts.slot] ??= {
    cache: null,
    inflight: null,
    generation: 0,
  });
  const fresh = (at: number, end: number) => end - at >= 0 && end - at < opts.ttlMs;

  return {
    clear() {
      state.cache = null;
      state.inflight = null;
      state.generation++;
    },
    async read(load, now = Date.now) {
      const t = now();
      const { cache } = state;
      if (cache && fresh(cache.at, t)) return opts.copy(cache.values);
      let mine = state.inflight;
      if (!mine || !fresh(mine.at, t)) {
        const gen = state.generation;
        const p = (async () => {
          const values = await load();
          // Only a real read is cached, and only if no clear came meanwhile.
          if (values !== null && gen === state.generation) state.cache = { at: t, values };
          return values;
        })();
        const started = { at: t, p };
        mine = state.inflight = started;
        const forget = () => void (state.inflight === started && (state.inflight = null));
        p.then(forget, forget);
      }
      try {
        const values = await mine.p;
        if (!fresh(mine.at, now())) {
          console.error(JSON.stringify({ event: `${opts.event}.read-stale`, ms: now() - mine.at }));
          return opts.fallback();
        }
        return values === null ? opts.fallback() : opts.copy(values);
      } catch (e) {
        console.error(JSON.stringify({ event: `${opts.event}.read-failed`, error: String(e) }));
        return opts.fallback();
      }
    },
  };
}
