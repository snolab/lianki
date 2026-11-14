/**
 * Time zones without a fixed default (owner, 2026-11-15: UTC is the default,
 * the user's own zone wherever it can be known; never JST by default).
 *
 * - `deviceZone()`: the zone of the device running the code (a browser: the
 *   viewer's; a script: the machine's), UTC when unknown.
 * - `ownerZone()`: for dev scripts that print times to the person running
 *   them: `LIANKI_OWNER_TZ` when set to a valid zone, else the machine's.
 * - `zoneOffsetMin()`: minutes east of UTC of a zone at a moment (DST-aware).
 * - `localDay()` / `localHour()`: the calendar bucket of a moment at a fixed
 *   offset, for SQL-free bucketing that matches `date(at, '+N minutes')`.
 * - `zoneAbbr()`: a short label ("JST", "EST", "CET"), falling back to a
 *   numeric one ("GMT+8") when no English name exists.
 *
 * Client-safe: imports nothing.
 */

/** Offsets beyond these do not exist (UTC−12 … UTC+14). */
export const MIN_OFFSET_MIN = -12 * 60;
export const MAX_OFFSET_MIN = 14 * 60;

/** True when `tz` is an IANA zone this runtime knows. */
export function validZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The zone this code runs in (the viewer's device, or the machine), UTC when unknown. */
export function deviceZone(): string {
  let tz: string | undefined;
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {}
  return validZone(tz) ? tz : "UTC";
}

/** The zone a dev script reports times in: LIANKI_OWNER_TZ when valid, else the machine's. */
export function ownerZone(
  env: Record<string, string | undefined> = (
    globalThis as { process?: { env: Record<string, string | undefined> } }
  ).process?.env ?? {},
): string {
  const o = env.LIANKI_OWNER_TZ;
  return validZone(o) ? o : deviceZone();
}

/** Minutes east of UTC of `tz` at `at` (e.g. 540 for Asia/Tokyo); 0 for an unknown zone. */
export function zoneOffsetMin(tz: string, at: number | Date = Date.now()): number {
  if (!validZone(tz)) return 0;
  const t = new Date(at);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(t);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return Math.round((asUtc - Math.floor(t.getTime() / 1000) * 1000) / 60_000);
}

/** A ±minutes offset parameter (e.g. `?tz=540`), clamped to real offsets; UTC (0) when missing or malformed. */
export function parseOffsetMin(s: string | null | undefined): number {
  if (s == null || s === "") return 0;
  const n = Number(s);
  if (!Number.isInteger(n)) return 0;
  return Math.min(MAX_OFFSET_MIN, Math.max(MIN_OFFSET_MIN, n));
}

/** "UTC", "UTC+9", "UTC−5:30" for an offset in minutes. */
export function offsetLabel(min: number): string {
  if (!min) return "UTC";
  const a = Math.abs(min);
  const h = Math.floor(a / 60);
  const m = a % 60;
  return `UTC${min > 0 ? "+" : "−"}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

/** The calendar day (YYYY-MM-DD) of `t` at a fixed offset of `offMin` minutes. */
export const localDay = (t: number | Date, offMin = 0) =>
  new Date(new Date(t).getTime() + offMin * 60_000).toISOString().slice(0, 10);

/** The hour (YYYY-MM-DDTHH) of `t` at a fixed offset of `offMin` minutes. */
export const localHour = (t: number | Date, offMin = 0) =>
  new Date(new Date(t).getTime() + offMin * 60_000).toISOString().slice(0, 13);

/** The UTC instant (ms) where local day `day` (YYYY-MM-DD) starts at offset `offMin`. */
export const dayStartMs = (day: string, offMin = 0) =>
  Date.parse(`${day}T00:00:00Z`) - offMin * 60_000;

const NUMERIC = /^(GMT|UTC)([+\-−]|$)/;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const abbrCache = new Map<string, string>();

/**
 * Conventional letter abbreviations for zones whose English short name ICU
 * may not carry (a small-ICU runtime, e.g. bun on CI, prints "GMT+9" for
 * every English locale): keyed by zone, then by the offset in minutes at
 * `at`, so daylight time picks its own name. Data, not a default zone.
 */
const ABBR_FALLBACK: Readonly<Record<string, Readonly<Record<number, string>>>> = {
  "Asia/Tokyo": { 540: "JST" },
  "Asia/Seoul": { 540: "KST" },
  "Asia/Shanghai": { 480: "CST" },
  "Asia/Taipei": { 480: "CST" },
  "Asia/Hong_Kong": { 480: "HKT" },
  "Asia/Singapore": { 480: "SGT" },
  "Asia/Kolkata": { 330: "IST" },
  "Australia/Sydney": { 600: "AEST", 660: "AEDT" },
  "Europe/London": { 0: "GMT", 60: "BST" },
  "Europe/Berlin": { 60: "CET", 120: "CEST" },
  "Europe/Paris": { 60: "CET", 120: "CEST" },
  "America/New_York": { [-300]: "EST", [-240]: "EDT" },
  "America/Chicago": { [-360]: "CST", [-300]: "CDT" },
  "America/Denver": { [-420]: "MST", [-360]: "MDT" },
  "America/Los_Angeles": { [-480]: "PST", [-420]: "PDT" },
};

/** The table's abbreviation for `tz` at offset `offMin`, or null when it has none. */
export function abbrFallback(tz: string, offMin: number): string | null {
  return ABBR_FALLBACK[tz]?.[offMin] ?? null;
}

/**
 * A short English label of `tz` at `at`: "JST", "EST", "CET", "UTC"; a
 * numeric "GMT+8" when no English locale names it. Which locale names a zone
 * is ICU data (en-US names US zones only), so the English locales are tried
 * by region code until one gives a name; the result is cached.
 */
export function zoneAbbr(tz: string, at: number | Date = Date.now()): string {
  const zone = validZone(tz) ? tz : "UTC";
  const key = `${zone}|${zoneOffsetMin(zone, at)}`;
  const hit = abbrCache.get(key);
  if (hit) return hit;
  const when = new Date(at);
  const name = (loc: string) => {
    try {
      return (
        new Intl.DateTimeFormat(loc, { timeZone: zone, timeZoneName: "short" })
          .formatToParts(when)
          .find((p) => p.type === "timeZoneName")?.value ?? ""
      );
    } catch {
      return "";
    }
  };
  const first = name("en-US");
  let out = first;
  if (NUMERIC.test(first) && zone !== "UTC") {
    search: for (const a of LETTERS)
      for (const b of LETTERS) {
        const v = name(`en-${a}${b}`);
        if (v && !NUMERIC.test(v)) {
          out = v;
          break search;
        }
      }
  }
  // No English locale names it on this runtime: the conventional letters, when known.
  if ((!out || NUMERIC.test(out)) && zone !== "UTC")
    out = abbrFallback(zone, zoneOffsetMin(zone, at)) ?? out;
  abbrCache.set(key, out);
  return out;
}

/** "Asia/Tokyo, UTC+9": a zone named for a reader, with its offset at `at`. */
export const zoneLabel = (tz: string, at: number | Date = Date.now()) =>
  tz === "UTC" ? "UTC" : `${tz}, ${offsetLabel(zoneOffsetMin(tz, at))}`;

/**
 * The last second (23:59:59) of calendar day `day` (YYYY-MM-DD) in zone `tz`,
 * as a UTC ISO instant; the zone's offset is taken on that day (DST-aware).
 */
export function endOfDayIso(day: string, tz: string): string {
  const off = zoneOffsetMin(tz, Date.parse(`${day}T12:00:00Z`));
  return new Date(Date.parse(`${day}T23:59:59Z`) - off * 60_000).toISOString();
}

/**
 * A short tag for `tz` at `at` that needs no locale scan: the en-US name when
 * it is a real abbreviation ("EST", "UTC"), else the offset ("UTC+9").
 */
export function zoneTag(tz: string, at: number | Date = Date.now()): string {
  const zone = validZone(tz) ? tz : "UTC";
  if (zone === "UTC" || zone === "Etc/UTC") return "UTC";
  const v =
    new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" })
      .formatToParts(new Date(at))
      .find((p) => p.type === "timeZoneName")?.value ?? "";
  return v && !NUMERIC.test(v) ? v : offsetLabel(zoneOffsetMin(zone, at));
}

/** `at` written in zone `tz` with Intl `opts` in `locale`, followed by the zone's tag. */
export function formatZoned(
  at: number | string | Date,
  tz: string,
  locale?: string,
  opts: Intl.DateTimeFormatOptions = { dateStyle: "long", timeStyle: "short" },
): string {
  const zone = validZone(tz) ? tz : "UTC";
  const when = new Date(at);
  return `${when.toLocaleString(locale, { ...opts, timeZone: zone })} ${zoneTag(zone, when)}`;
}

/** "2026-11-07 10:02" (or with `:03` seconds) — `at` on the wall clock of `tz`. */
export function zonedStamp(at: number | Date, tz: string, seconds = false): string {
  const t = new Date(at).getTime();
  return new Date(t + zoneOffsetMin(tz, t) * 60_000)
    .toISOString()
    .slice(0, seconds ? 19 : 16)
    .replace("T", " ");
}
