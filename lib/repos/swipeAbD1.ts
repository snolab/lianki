import type { D1Like } from "@/lib/d1/types";
import { type SwipeAbStats, type SwipeLogRow, summarizeSwipeAb } from "@/lib/words/swipe-ab";

/**
 * The swipe A/B comparison for the owner's /dev/swipe-ab: every tagged
 * swipe_log row, summed per variant (lib/words/swipe-ab.ts). Only rows since
 * the comparison began carry `ab=`, so the LIKE keeps the scan to those.
 */
export async function swipeAbStats(
  db: D1Like,
): Promise<{ stats: SwipeAbStats[]; first: string | null; last: string | null }> {
  const { results } = await db
    .prepare(
      `SELECT email, finger, rating, params, at FROM swipe_log
       WHERE params LIKE '%ab=%' ORDER BY at`,
    )
    .all<SwipeLogRow & { at: string }>();
  return {
    stats: summarizeSwipeAb(results),
    first: results[0]?.at ?? null,
    last: results.at(-1)?.at ?? null,
  };
}
