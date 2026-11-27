/**
 * Each roadmap step's measure (types/roadmap.ts `StepMeasure`): what it is
 * counted in, how much is done, and the per-day log over the pace window
 * that lib/roadmap/eta.ts turns into an estimate.
 *
 * - keywords: mature page cards / matching page cards; no per-day log.
 * - deck: words introduced / the catalogue deck's size, the log = new words
 *   learned a day in the learner's lists built from that deck
 *   (word_reviews rows whose card was New before the review).
 * - doc: ticked / all checklist items (n/a without a checklist), the log =
 *   the doc's `doneLog`.
 */
import type { RoadmapNodeProgress, StepMeasure } from "@/types/roadmap";
import type { D1Like } from "@/lib/d1/types";
import { countChecks } from "./doc-checklist";
import { addDays, dailyCounts } from "./eta";

/** One deck's numbers for one learner. */
export type DeckStat = { seen: number; total: number; byDay: Record<string, number> };

export function measureStep(
  n: RoadmapNodeProgress,
  ctx: { today: string; windowDays: number; decks: Record<string, DeckStat> },
): StepMeasure {
  if (n.kind === "deck" && n.deck) {
    const d = ctx.decks[n.deck.id];
    return {
      unit: "words",
      done: Math.min(d?.seen ?? 0, d?.total ?? 0),
      total: d?.total ?? null,
      daily: dailyCounts(d?.byDay ?? {}, ctx.today, ctx.windowDays),
    };
  }
  if (n.kind === "doc") {
    const { done, total } = countChecks(n.doc?.markdown ?? "");
    return {
      unit: "items",
      done,
      total: total === 0 ? null : total,
      daily: dailyCounts(n.doc?.doneLog ?? [], ctx.today, ctx.windowDays),
    };
  }
  return { unit: "cards", done: n.matureCards, total: n.totalCards, daily: null };
}

/**
 * The learner's numbers for each catalogue deck in `ids` (D1): words seen in
 * their lists built from it, the deck's size, and new words a day since the
 * window began. Reads only; nothing is written.
 */
export async function loadDeckStats(
  db: D1Like,
  email: string,
  ids: string[],
  sizes: Record<string, number>,
  today: string,
  windowDays: number,
): Promise<Record<string, DeckStat>> {
  const out: Record<string, DeckStat> = {};
  const since = `${addDays(today, -(windowDays - 1))}T00:00:00.000Z`;
  for (const id of [...new Set(ids)].slice(0, 20)) {
    const total = sizes[id] ?? 0;
    const { results: lists } = await db
      .prepare("SELECT id FROM word_lists WHERE email = ? AND source = ?")
      .bind(email, id)
      .all<{ id: string }>();
    const listIds = lists.map((l) => l.id);
    if (!listIds.length) {
      out[id] = { seen: 0, total, byDay: {} };
      continue;
    }
    const marks = listIds.map(() => "?").join(", ");
    const seenRow = await db
      .prepare(`SELECT COUNT(*) AS n FROM word_cards WHERE email = ? AND list_id IN (${marks})`)
      .bind(email, ...listIds)
      .first<{ n: number }>();
    const { results: days } = await db
      .prepare(
        `SELECT substr(reviewed_at, 1, 10) AS d, SUM(state = 0) AS n FROM word_reviews
         WHERE email = ? AND list_id IN (${marks}) AND reviewed_at >= ? GROUP BY d`,
      )
      .bind(email, ...listIds, since)
      .all<{ d: string; n: number }>();
    out[id] = {
      seen: seenRow?.n ?? 0,
      total,
      byDay: Object.fromEntries(days.map((r) => [r.d, r.n ?? 0])),
    };
  }
  return out;
}
