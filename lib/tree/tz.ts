/**
 * Time zones for the plan and calendar (docs/calendar-plan.md, section 2).
 *
 * The user's zone is the browser's IANA zone, stored in preferences. When no
 * zone is known — never set, an invalid name, an agent or API call with no
 * browser — Lianki uses UTC and says so: ISO 8601 with an explicit `Z`
 * (2026-10-31T09:00Z), UTC days. It never guesses a zone (owner, 2026-10-31).
 */

export const UTC = "UTC";

/** True for a zone name Intl accepts (IANA names, "UTC"). */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The zone to use, and whether it is a real choice or the UTC fallback. */
export type ResolvedZone = { tz: string; known: boolean };

/** First valid candidate wins; none → UTC, marked unknown. */
export function resolveTimeZone(...candidates: unknown[]): ResolvedZone {
  for (const c of candidates) if (isValidTimeZone(c)) return { tz: c, known: true };
  return { tz: UTC, known: false };
}

/** UTC instant written out with an explicit Z, to the minute: 2026-10-31T09:00Z. */
export function isoUtcMinute(d: Date | string | number): string {
  return new Date(d).toISOString().slice(0, 16) + "Z";
}

/** The zone's offset from UTC at instant `at`, in minutes (Tokyo: +540). */
export function offsetMinutes(tz: string, at: Date | number): number {
  const t = typeof at === "number" ? at : at.getTime();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(t));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return Math.round((asUtc - Math.floor(t / 1000) * 1000) / 60000);
}

/** The local calendar day (YYYY-MM-DD) of instant `at` in `tz`. */
export function localDay(tz: string, at: Date | number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
}

/** A YYYY-MM-DD string, checked. */
export function isDay(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
}

/** Add `n` days to a YYYY-MM-DD (calendar arithmetic, no zone involved). */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * The UTC instant at which local `day` starts in `tz` (local midnight). Found
 * by guessing with the offset at UTC midnight and correcting once, which is
 * exact except inside a DST gap at midnight (then the first valid instant).
 */
export function dayStartUtc(tz: string, day: string): Date {
  const midnightUtc = Date.parse(`${day}T00:00:00Z`);
  let guess = midnightUtc - offsetMinutes(tz, midnightUtc) * 60000;
  const corrected = midnightUtc - offsetMinutes(tz, guess) * 60000;
  if (corrected !== guess && localDay(tz, corrected) === day) guess = corrected;
  return new Date(guess);
}
