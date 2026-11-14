/**
 * Times the dev scripts print for the person running them: in the machine's
 * zone, or `LIANKI_OWNER_TZ` when set (owner, 2026-11-15: no JST default
 * anywhere, scripts included), always labelled with that zone's short name
 * ("JST" on a Mac in Tokyo, "CET" in Berlin, "UTC" on a server).
 */
import { ownerZone, zoneAbbr, zonedStamp } from "../../lib/time-zone";

/** The zone's short label at `at`, e.g. "JST". */
export const ownerTag = (at: number | Date = Date.now()) => zoneAbbr(ownerZone(), at);

/** "2026-11-07 10:02 JST" (with seconds when asked). */
export const ownerStamp = (at: number | Date, seconds = false) =>
  `${zonedStamp(at, ownerZone(), seconds)} ${ownerTag(at)}`;

/** "2026-11-07 10:02" without the label (for a column whose heading names it). */
export const ownerStampBare = (at: number | Date, seconds = false) =>
  zonedStamp(at, ownerZone(), seconds);

/** "10:02": the clock time alone. */
export const ownerClock = (at: number | Date) => zonedStamp(at, ownerZone()).slice(11, 16);
