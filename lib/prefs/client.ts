/**
 * Starts the account preference sync on a signed-in page (docs/prefs-sync.md,
 * "When it syncs"). Loaded lazily by app/components/PrefSync.tsx, so the
 * schemas stay out of the first paint, which uses the local copy anyway.
 *
 * Event-driven, nothing polls:
 * - now: scan, pull (the server's newer values), push what is pending;
 * - the tab is shown, or the device comes online: pull again — how a change
 *   made on another device arrives;
 * - `lk:pref-write` (a setting was just changed here): scan, push 1 s later;
 * - the tab is hidden or the page goes away: scan and push at once (keepalive).
 */
import { createPrefSync, PREF_WRITE_EVENT, type PrefSync } from "@lianki/ui-state/account";
import { prefBindings } from "@/lib/prefs/bindings";
import { checkPref } from "@/lib/prefs/schema";

const KEY = "__lkPrefSync";

export function startPrefSync(): PrefSync | null {
  if (typeof window === "undefined") return null;
  const g = globalThis as unknown as Record<string, PrefSync | undefined>;
  if (g[KEY]) {
    void g[KEY].pull();
    return g[KEY];
  }
  let storage: Storage;
  try {
    storage = window.localStorage;
  } catch {
    return null;
  }
  const bindings = prefBindings();
  const sync = createPrefSync({
    bindings: () => bindings,
    validate: checkPref,
    fetch: (u, i) => fetch(u, i),
    storage,
    log: (ev, data) => {
      if (ev.endsWith("failed") || ev === "prefs-bad-value" || ev === "prefs-rejected")
        console.warn(`[Lianki] ${ev}`, data ?? "");
    },
  });
  g[KEY] = sync;

  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener(PREF_WRITE_EVENT, () => {
    // After the writer's own bookkeeping (and after an applied value is recorded).
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => sync.scan(), 0);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void sync.pull();
    else void sync.flush(true);
  });
  window.addEventListener("pagehide", () => void sync.flush(true));
  window.addEventListener("online", () => void sync.pull());
  void sync.pull();
  return sync;
}
