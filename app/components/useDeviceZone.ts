"use client";

import { useSyncExternalStore } from "react";
import { deviceZone } from "@/lib/time-zone";

const subscribe = () => () => {};

/**
 * The viewer's device time zone (IANA name), or null while server-rendering
 * and hydrating: the server cannot know it, so a time shown in it waits for
 * the client (no hydration mismatch, and never a fixed zone in its place).
 */
export function useDeviceZone(): string | null {
  return useSyncExternalStore(subscribe, deviceZone, () => null);
}
