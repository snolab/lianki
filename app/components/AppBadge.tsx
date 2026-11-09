"use client";

// The app-icon badge (docs/app-badge.md, lib/app-badge.ts): sets the number
// on open, when the tab comes back, when the setting changes, and lowers it
// when something counted is dealt with. `on` is the server's appBadgeOn (`pwa.app-badge`, owner only)
// for this signed-in user; off, the badge is cleared once and nothing else
// runs. Nothing polls.

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { PREF_APPLIED_EVENT } from "@lianki/ui-state/account";
import {
  BADGE_ENDPOINT,
  BADGE_MODE_EVENT,
  BADGE_PREF_KEY,
  BADGE_SEEN_EVENT,
  type BadgeDelta,
  type BadgeMode,
  type BadgeNav,
  badgeController,
  parseCounts,
  readBadgeMode,
  setBadge,
} from "@/lib/app-badge";

async function fetchCounts(mode: BadgeMode) {
  const r = await fetch(`${BADGE_ENDPOINT}?mode=${mode}`, {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!r.ok) return null;
  const j = (await r.json()) as { on?: boolean };
  return j.on === true ? parseCounts(j) : { asks: 0, due: 0 };
}

function tellWorker(mode: BadgeMode) {
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: "badge-mode", mode });
  } catch {}
}

export function AppBadge({ on }: { on: boolean }) {
  const path = usePathname();
  const pathRef = useRef(path);
  const ctl = useRef<ReturnType<typeof badgeController> | null>(null);

  useEffect(() => {
    const nav = typeof navigator === "undefined" ? null : (navigator as unknown as BadgeNav);
    if (!on) {
      void setBadge(nav, 0);
      return;
    }
    const c = badgeController({
      nav,
      fetchCounts,
      mode: readBadgeMode,
      path: () => pathRef.current,
      now: Date.now,
      tellWorker,
    });
    ctl.current = c;
    void c.refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") void c.refresh();
    };
    const onMode = () => void c.refresh(true);
    const onApplied = (e: Event) => {
      if ((e as CustomEvent<{ key?: string }>).detail?.key === "notify.badge") onMode();
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === BADGE_PREF_KEY) onMode();
    };
    const onSeen = (e: Event) => void c.seen((e as CustomEvent<BadgeDelta>).detail ?? {});
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(BADGE_MODE_EVENT, onMode);
    window.addEventListener(PREF_APPLIED_EVENT, onApplied);
    window.addEventListener("storage", onStorage);
    window.addEventListener(BADGE_SEEN_EVENT, onSeen);
    return () => {
      ctl.current = null;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(BADGE_MODE_EVENT, onMode);
      window.removeEventListener(PREF_APPLIED_EVENT, onApplied);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(BADGE_SEEN_EVENT, onSeen);
    };
  }, [on]);

  // Another screen: its part of the number may count as seen now (seenOn).
  useEffect(() => {
    pathRef.current = path;
    void ctl.current?.render();
  }, [path]);

  return null;
}
