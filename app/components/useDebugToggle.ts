"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { debugOn, devLog, setDebug } from "@/lib/debug-client";

/**
 * The hidden switch for debug mode (lib/debug-client.ts): seven quick taps,
 * as on Android's build number. The installed app has no address bar for
 * ?debug=1. Bound to /words' Settings button and to the version line at the
 * bottom of /preferences. Returns [on, tap].
 */
export function useDebugToggle(onChange?: (on: boolean) => void): [boolean, () => void] {
  const [on, setOn] = useState(false);
  useEffect(() => setOn(debugOn()), []);
  const taps = useRef<number[]>([]);
  const tap = useCallback(() => {
    const now = Date.now();
    taps.current = [...taps.current.filter((t) => now - t < 3000), now];
    if (taps.current.length < 7) return;
    taps.current = [];
    const next = !debugOn();
    setDebug(next);
    setOn(next);
    onChange?.(next);
    if (next) devLog({ ev: "debug-on", ua: navigator.userAgent });
  }, [onChange]);
  return [on, tap];
}
