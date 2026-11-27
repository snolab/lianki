/**
 * The words of an estimate and a pace verdict (lib/roadmap/eta.ts) in the
 * page's language: "about 12 days, ~9 December", "Behind by 5 days: you need
 * about 20 new words a day to finish by 1 March 2027". Dates are written out
 * (docs: no numeric 11/5 dates), the year only when it is not this year.
 * Strings come from the `roadmap-steps` dictionary. Pure.
 */
import type { ProgressUnit } from "@/types/roadmap";
import type { Eta, PaceVerdict, RoadmapEta } from "./eta";
import { countLabel, fill } from "./labels";

export type EtaStrings = {
  daysOne: string;
  daysOther: string;
  etaLine: string;
  etaFinished: string;
  etaTooLittle: string;
  etaNone: string;
};

export type PaceStrings = EtaStrings & {
  paceOnPaceDetail: string;
  paceAheadDetail: string;
  paceBehindDetail: string;
  paceNoDataDetail: string;
  paceNoTarget: string;
  needWords: string;
  needItems: string;
};

/** A YYYY-MM-DD day written out: "9 December", or "9 December 2027" in another year. */
export function dayText(day: string, locale: string, today: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  if (!Number.isFinite(d.getTime())) return day;
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  const loc = locale === "zh-Hant" ? "zh-TW" : locale;
  return d.toLocaleDateString(loc, {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

export const daysText = (locale: string, n: number, s: Pick<EtaStrings, "daysOne" | "daysOther">) =>
  countLabel(locale, n, s.daysOne, s.daysOther);

/** One step's or the whole roadmap's estimate, as one short line. */
export function etaText(e: Eta | RoadmapEta, locale: string, today: string, s: EtaStrings): string {
  if (e.kind === "done") return s.etaFinished;
  if (e.kind === "na") return s.etaNone;
  if (e.kind === "too-little") return s.etaTooLittle;
  return fill(s.etaLine, {
    days: daysText(locale, e.days, s),
    date: dayText(e.date, locale, today),
  });
}

/** "20 new words + 2 checklist items". Page cards have no pace, so never appear. */
export function needText(
  need: Partial<Record<ProgressUnit, number>>,
  locale: string,
  s: Pick<PaceStrings, "needWords" | "needItems">,
): string {
  const parts: string[] = [];
  const n = (v: number) => v.toLocaleString(locale);
  if (need.words) parts.push(fill(s.needWords, { n: n(need.words) }));
  if (need.items) parts.push(fill(s.needItems, { n: n(need.items) }));
  return parts.join(" + ");
}

/** The line under the pace indicator. */
export function verdictText(v: PaceVerdict, locale: string, today: string, s: PaceStrings): string {
  if (v.state === "no-target") return s.paceNoTarget;
  const date = dayText(v.target, locale, today);
  if (v.state === "no-data") return fill(s.paceNoDataDetail, { date });
  if (v.state === "on-pace") return fill(s.paceOnPaceDetail, { date });
  if (v.state === "ahead")
    return fill(s.paceAheadDetail, { date, days: daysText(locale, v.by, s) });
  return fill(s.paceBehindDetail, {
    date,
    days: daysText(locale, v.by, s),
    need: needText(v.need, locale, s),
  });
}
