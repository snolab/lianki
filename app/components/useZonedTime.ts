"use client";

import { useCallback } from "react";
import { formatZoned, localDay, zoneOffsetMin } from "@/lib/time-zone";
import { useDeviceZone } from "./useDeviceZone";

/**
 * Times for a reader, in the viewer's device zone and labelled with it
 * ("2026年11月15日 04:00 UTC+9"). While server-rendering and hydrating the
 * zone is not known yet: UTC, labelled UTC, then the device zone once the
 * page runs. Never a fixed zone.
 */
export function useZonedTime() {
  const zone = useDeviceZone() ?? "UTC";
  const time = useCallback(
    (at: number | string | Date, locale?: string, opts?: Intl.DateTimeFormatOptions) =>
      formatZoned(at, zone, locale, opts),
    [zone],
  );
  /** The ISO calendar day (YYYY-MM-DD) of `at` in the zone. */
  const day = useCallback(
    (at: number | string | Date) => localDay(new Date(at), zoneOffsetMin(zone, new Date(at))),
    [zone],
  );
  return { zone, time, day };
}
