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
