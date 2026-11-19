/**
 * Dates people read: written out in full ("5 November 2026", "2026年11月5日"),
 * never the numeric 11/5/2026 that reads as May in half the world.
 * `locale` undefined = the reader's own.
 */
export const longDate = (d: Date | string | number, locale?: string): string => {
  const t = toDate(d);
  return t ? t.toLocaleDateString(locale, { dateStyle: "long" }) : NO_DATE;
};

export const longDateTime = (d: Date | string | number, locale?: string): string => {
  const t = toDate(d);
  return t ? t.toLocaleString(locale, { dateStyle: "long", timeStyle: "short" }) : NO_DATE;
};

/** For machine-ish labels (an import's default title): 2026-11-05. */
export const isoDay = (d: Date | string | number = new Date()): string => {
  const t = toDate(d);
  return t ? t.toLocaleDateString("en-CA") : NO_DATE;
};

/** What a time that cannot be read is shown as. */
export const NO_DATE = "—";

/** Digits only (optionally signed / with a fraction): epoch milliseconds sent as text. */
const NUMERIC_TIME = /^-?\d+(\.\d+)?$/;

/**
 * A moment as epoch milliseconds, or null when it cannot be one. Accepts a
 * number, a Date, an ISO / SQL date string, and epoch milliseconds sent as a
 * string ("1794387558000" — a number bound into a D1 TEXT column comes back
 * like that, and `new Date("1794387558000")` is Invalid Date).
 */
export function toEpochMs(v: unknown): number | null {
  let t: number;
  if (typeof v === "number") t = v;
  else if (v instanceof Date) t = v.getTime();
  else if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    t = NUMERIC_TIME.test(s) ? Number(s) : Date.parse(s);
  } else return null;
  // Beyond ±8.64e15 ms a Date is invalid too.
  return Number.isFinite(t) && Math.abs(t) <= 8.64e15 ? t : null;
}

/** `toEpochMs` as a Date: null instead of an Invalid Date (which makes Intl throw). */
export function toDate(v: unknown): Date | null {
  const t = toEpochMs(v);
  return t === null ? null : new Date(t);
}

/** ISO order, in the viewer's time zone: 2026-11-05 18:11; "—" when unreadable. */
export const shortStamp = (v: unknown): string => {
  const t = toDate(v);
  return t ? t.toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" }) : NO_DATE;
};

const CJK = /^(zh|ja|ko)/;

/** `zh-Hant` alone gives numeric dates in ICU; its Taiwan form writes them out. */
const intlLocale = (locale: string) => (locale === "zh-Hant" ? "zh-TW" : locale);

/** True when `tz` is an IANA zone this runtime knows. */
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * A moment in a given zone, written out and labelled with that zone:
 * "2026年11月9日 18:07（日本标准时间 GMT+9）", "November 9, 2026 at 6:07 PM
 * (Japan Standard Time, GMT+9)". An unknown zone gives UTC, labelled "UTC".
 * For places the reader is not on the page (mail), so the zone is named.
 */
export function zonedDateTime(
  d: Date | string | number,
  locale: string,
  timeZone?: string | null,
): string {
  const loc = intlLocale(locale);
  const tz = isTimeZone(timeZone) && timeZone !== "Etc/UTC" ? timeZone : "UTC";
  const when = toDate(d);
  if (!when) return NO_DATE;
  const text = new Intl.DateTimeFormat(loc, {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: tz,
  }).format(when);
  const part = (o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(loc, { ...o, timeZone: tz })
      .formatToParts(when)
      .find((p) => p.type === "timeZoneName")?.value ?? "";
  const cjk = CJK.test(locale);
  const zone =
    tz === "UTC"
      ? "UTC"
      : [part({ timeZoneName: "longGeneric" }), part({ timeZoneName: "shortOffset" })]
          .filter(Boolean)
          .join(cjk ? " " : ", ");
  return cjk ? `${text}（${zone}）` : `${text} (${zone})`;
}
