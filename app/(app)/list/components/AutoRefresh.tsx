"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/**
 * Keeps the list fresh without a manual reload.
 *
 * The page is a server component (`dynamic = "force-dynamic"`), so it is
 * accurate when rendered and frozen thereafter. Reviews almost never happen
 * here — they happen in the userscript, on some other site, in another tab — so
 * the tab you left open on /list drifts out of date with no sign that it has.
 *
 * `router.refresh()` re-runs the server component and reconciles in place:
 * scroll position, focus and client state survive, so a refresh that lands while
 * you are reading is not disruptive.
 *
 * Three triggers, cheapest first:
 *  - returning to the tab (the common case: review elsewhere, come back)
 *  - the userscript writing its status key, which it does after each sync
 *  - a slow poll, only while the tab is actually visible
 */
export function AutoRefresh({ intervalMs = 30_000 }: { intervalMs?: number }) {
  const router = useRouter();
  // Refreshing on every focus event is wasteful when tabbing back and forth.
  const lastRef = useRef(0);

  useEffect(() => {
    const refresh = (minGapMs = 2_000) => {
      const now = Date.now();
      if (now - lastRef.current < minGapMs) return;
      lastRef.current = now;
      router.refresh();
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    // The userscript rewrites lk:status after syncing; a change means review
    // activity happened somewhere. Only fires for OTHER tabs, which is exactly
    // the case a focus handler cannot see.
    const onStorage = (e: StorageEvent) => {
      if (e.key === "lk:status") refresh();
    };

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("storage", onStorage);

    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh(intervalMs - 1_000);
    }, intervalMs);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("storage", onStorage);
      clearInterval(timer);
    };
  }, [router, intervalMs]);

  return null;
}
