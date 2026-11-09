// Today's goal (/today, flag `today.goal`): one number, the cards left today,
// and how far the day has come. Pure.
//
// The numbers are /words's own: a list counts when /words shows it (a
// catalog list or an imported one; not /alphabet's, not a group), and "left"
// is the cards due now, the same sum as /home's "due" and the picker's. /words
// has no daily cap on new words (lib/words/new-order.ts: an endless stream),
// so new words are not counted as owed; they come after the reviews.
// "Done" is the cards of those lists reviewed since the local midnight that
// are not due again (GET /api/words/today).
import { isEntrySource } from "@/lib/words/entry-list";

export type GoalList = { id?: string; source?: string | null; due?: number };

/**
 * The lists /words shows. Without the catalog (offline, first visit), every
 * list that is not a group.
 */
export function shownLists<T extends GoalList>(
  lists: readonly T[],
  catalogIds: Set<string> | null,
): T[] {
  return lists.filter((l) =>
    catalogIds
      ? !!l.source && (catalogIds.has(l.source) || isEntrySource(l.source))
      : !l.source?.startsWith("group:"),
  );
}

/** Cards due now across these lists. */
export function dueNow(lists: readonly GoalList[]): number {
  return lists.reduce((s, l) => s + Math.max(0, l.due ?? 0), 0);
}

export interface Goal {
  /** Cards left today: due now. */
  left: number;
  /** Cards done today. */
  done: number;
  /** Share of the day's cards done, 0..1; 1 when nothing is left. */
  share: number;
}

export function goal(left: number, done: number): Goal {
  const l = Math.max(0, Math.floor(left) || 0);
  const d = Math.max(0, Math.floor(done) || 0);
  return { left: l, done: d, share: l === 0 ? 1 : d / (d + l) };
}

/** The local midnight starting the day of `now`, as an ISO instant (UTC). */
export function localMidnight(now = new Date()): string {
  const m = new Date(now);
  m.setHours(0, 0, 0, 0);
  return m.toISOString();
}

/** The done counts per list, summed over the lists shown. */
export function doneIn(lists: readonly GoalList[], perList: Record<string, number>): number {
  return lists.reduce((s, l) => s + Math.max(0, (l.id && perList[l.id]) || 0), 0);
}
