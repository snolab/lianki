/**
 * Card counts per site for the /home start page. Pure, so the same grouping
 * serves the cloud store (rows from /api/fsrs/hosts) and the local mirror
 * (IndexedDB) without a database in the test.
 *
 * Groups by `siteOf()` rather than exact host: a learner reading
 * `movie.douban.com` and `book.douban.com` has been on Douban, and the matrix
 * lists Douban once.
 */
import { siteOf } from "@/lib/next-card";

export type SiteStat = {
  site: string;
  count: number;
  /** Due now — what a review session would actually serve from this site. */
  due: number;
  /** A real url on the site, so a link can land on something the user read. */
  sampleUrl: string;
};

export type CardRow = { url: string; due?: string | Date | null };

export function siteStats(rows: CardRow[], now = Date.now()): Map<string, SiteStat> {
  const stats = new Map<string, SiteStat>();
  for (const { url, due } of rows) {
    const site = siteOf(url);
    if (!site) continue;
    const s = stats.get(site) ?? { site, count: 0, due: 0, sampleUrl: url };
    s.count++;
    if (due && new Date(due).getTime() <= now) s.due++;
    stats.set(site, s);
  }
  return stats;
}

/** Sites with cards, most urgent first: due count, then total, then name. */
export function rankSites(stats: Map<string, SiteStat>): SiteStat[] {
  return [...stats.values()].sort(
    (a, b) => b.due - a.due || b.count - a.count || a.site.localeCompare(b.site),
  );
}
