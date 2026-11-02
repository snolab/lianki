"use client";

import { useEffect } from "react";
import { type DirtyMode, confirmLeave, registerDirtyCheck } from "./page-dirty";

/**
 * For a component that switches tabs or panels, or pushes a route by code:
 * returns confirmLeave — call it first, and go ahead only on true (the page
 * is clean, or he confirmed). `dirty` adds this component's own unsaved state
 * to the page's (lib/page-dirty.ts) while it is true; `modes` limits it, e.g.
 * ["reload"] for a request in flight that leaving in-app would not lose.
 */
export function useLeaveGuard(dirty = false, modes: DirtyMode[] = ["reload", "leave"]) {
  const key = modes.join();
  useEffect(() => {
    if (!dirty) return;
    const on = new Set(key.split(","));
    return registerDirtyCheck((m) => on.has(m));
  }, [dirty, key]);
  return confirmLeave;
}
