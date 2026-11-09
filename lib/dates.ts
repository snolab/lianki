/**
 * Dates people read: written out in full ("5 November 2026", "2026年11月5日"),
 * never the numeric 11/5/2026 that reads as May in half the world.
 * `locale` undefined = the reader's own.
 */
export const longDate = (d: Date | string | number, locale?: string): string =>
  new Date(d).toLocaleDateString(locale, { dateStyle: "long" });

export const longDateTime = (d: Date | string | number, locale?: string): string =>
  new Date(d).toLocaleString(locale, { dateStyle: "long", timeStyle: "short" });

/** For machine-ish labels (an import's default title): 2026-11-05. */
export const isoDay = (d: Date | string | number = new Date()): string =>
  new Date(d).toLocaleDateString("en-CA");

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
  const when = new Date(d);
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
