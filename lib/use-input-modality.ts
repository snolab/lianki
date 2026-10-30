"use client";

import { useSyncExternalStore } from "react";
import { createModalityTracker, type Modality } from "@/lib/input-modality";

let tracker: ReturnType<typeof createModalityTracker> | null = null;
function browserTracker() {
  tracker ??= createModalityTracker({
    matchMedia: (q) => window.matchMedia(q),
    storage: (() => {
      try {
        return window.localStorage;
      } catch {
        return undefined;
      }
    })(),
    addEventListener: (t, fn, o) => window.addEventListener(t, fn, o),
    removeEventListener: (t, fn, o) => window.removeEventListener(t, fn, o),
    keyEnv: () => {
      const a = document.activeElement as HTMLElement | null;
      return {
        textFocused:
          !!a &&
          (a.isContentEditable ||
            a.tagName === "TEXTAREA" ||
            (a.tagName === "INPUT" &&
              !/^(button|checkbox|radio|range|submit|reset|file|color)$/.test(
                (a as HTMLInputElement).type,
              ))),
        viewportHeight: window.visualViewport?.height,
        innerHeight: window.innerHeight,
      };
    },
  });
  return tracker;
}

/**
 * The input used last ("touch" | "keyboard"), or null while server-rendering
 * — render no hints then, rather than the wrong ones.
 */
export function useInputModality(): Modality | null {
  return useSyncExternalStore<Modality | null>(
    (fn) => browserTracker().subscribe(fn),
    () => browserTracker().get(),
    () => null,
  );
}
