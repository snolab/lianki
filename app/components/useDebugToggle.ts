"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { debugOn, devLog, setDebug } from "@/lib/debug-client";

/**
 * The hidden switch for debug mode (lib/debug-client.ts): `taps` quick taps
 * within 3 s, as on Android's build number. The installed app has no address
 * bar for ?debug=1. Bound to /words' Settings button (7) and to your own name
 * in the profile menu (10). Returns [on, tap].
 */
export function useDebugToggle(onChange?: (on: boolean) => void, taps = 7): [boolean, () => void] {
  const [on, setOn] = useState(false);
  useEffect(() => setOn(debugOn()), []);
  const recent = useRef<number[]>([]);
  const tap = useCallback(() => {
    const now = Date.now();
    recent.current = [...recent.current.filter((t) => now - t < 3000), now];
    if (recent.current.length < taps) return;
    recent.current = [];
    const next = !debugOn();
    setDebug(next);
    setOn(next);
    onChange?.(next);
    if (next) devLog({ ev: "debug-on", ua: navigator.userAgent });
  }, [onChange, taps]);
  return [on, tap];
}
