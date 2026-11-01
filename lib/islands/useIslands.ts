/**
 * Turns hot islands on and off for this page (docs/dev-hot-islands.md).
 * Mounted once, by DebugEval. With a verified live-view pointer that names
 * islands, it loads them from there for as long as the pointer lasts.
 * Otherwise it does nothing unless `lk:slots-src` is set on a dev build or
 * localhost; then it starts the loader (a separate chunk) while the page
 * holds a code-run grant (DebugEval feeds islandStore.setGrant from the hub's
 * state), and stops it — every island back to built in — when the grant ends. It imports
 * nothing heavy: the loader, the module map and zod load only once active.
 */
import { useEffect } from "react";
import { useLiveView } from "@/lib/live-view/client";
import { unsignedOverridesAllowed } from "@/lib/live-view/rules";
import { ISLANDS_SRC_KEY, islandsSrc } from "./rules";
import { islandStore } from "./store";

const note = (n: string) =>
  // Lazily: shared-state brings zod, which no page should load for this.
  void import("./shared-state").then((m) =>
    m.writeShared("islands.status", { active: false, rev: "", names: [], note: n }),
  );

export function useIslands() {
  // Live view (docs/live-view.md): a verified pointer is the source, and its
  // expiry the permission. Otherwise the old key, where unsigned overrides
  // are still allowed (dev builds, localhost) — never on lianki.com.
  const live = useLiveView();
  const liveSrc = live.on ? live.claim.islands : undefined;
  const liveExp = live.on ? live.claim.exp * 1000 : null;
  useEffect(() => {
    let src: URL | null = null;
    if (liveSrc && liveExp) {
      src = new URL(liveSrc);
      islandStore.setLive(liveExp);
    } else {
      islandStore.setLive(null);
      let raw: string | null = null;
      try {
        raw = localStorage.getItem(ISLANDS_SRC_KEY);
      } catch {}
      if (!raw) return;
      if (!unsignedOverridesAllowed()) {
        note(`islands: ${ISLANDS_SRC_KEY} is ignored here; turn on Live view (docs/live-view.md)`);
        return;
      }
      src = islandsSrc(raw);
      if (!src) {
        note(
          `islands ignored: ${raw.slice(0, 80)} is not an allowed origin (https *.ts.net, or localhost)`,
        );
        return;
      }
    }
    const from = src;
    // Local dev only (compiled out of production): the hub that grants code
    // runs does not run under `next dev`, so tests grant it by hand.
    if (process.env.NODE_ENV !== "production")
      (globalThis as Record<string, unknown>).__lkIslandsGrant = (until: number | null) =>
        islandStore.setGrant(until);
    let stop: (() => void) | null = null;
    let starting = false;
    let alive = true;
    const apply = () => {
      if (islandStore.granted() && !stop && !starting) {
        starting = true;
        void import("./page").then((m) => {
          starting = false;
          if (alive && islandStore.granted() && !stop) stop = m.startIslandsInPage(from);
        });
      } else if (!islandStore.granted() && stop) {
        const s = stop;
        stop = null;
        s();
      }
    };
    const unsub = islandStore.subscribe(apply);
    apply();
    return () => {
      alive = false;
      unsub();
      stop?.();
      if (liveSrc) islandStore.setLive(null);
    };
  }, [liveSrc, liveExp]);
}
