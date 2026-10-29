/**
 * Turns hot islands on and off for this page (docs/dev-hot-islands.md).
 * Mounted once, by DebugEval. Does nothing unless `lk:slots-src` is set; then
 * it starts the loader (a separate chunk) while the page holds a code-run
 * grant (DebugEval feeds islandStore.setGrant from the hub's state), and
 * stops it — every island back to built in — when the grant ends.
 */
import { useEffect } from "react";
import { ISLANDS_SRC_KEY, islandsSrc } from "./rules";
import { writeShared } from "./shared-state";
import { islandStore } from "./store";

export function useIslands() {
  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(ISLANDS_SRC_KEY);
    } catch {}
    if (!raw) return;
    const src = islandsSrc(raw);
    if (!src) {
      writeShared("islands.status", {
        active: false,
        rev: "",
        names: [],
        note: `islands ignored: ${raw.slice(0, 80)} is not an allowed origin (https *.ts.net, or localhost)`,
      });
      return;
    }
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
          if (alive && islandStore.granted() && !stop) stop = m.startIslandsInPage(src);
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
    };
  }, []);
}
