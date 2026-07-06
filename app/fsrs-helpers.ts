// HLC, compareHLC, newServerHLC and RATING_MAP moved to @lianki/core (framework
// neutral). Re-exported here for back-compat with existing `@/app/fsrs-helpers`
// imports. The Mongo-specific `buildNextDueQuery` stays here — it's only used by
// the Next/Mongo fsrs handler.
export { compareHLC, newServerHLC, RATING_MAP, type HLC } from "@lianki/core";

/**
 * Build a MongoDB query for the next due card.
 * @param excludeDomains - comma-separated domain list from query params
 * @param excludeUrl - URL of the just-reviewed card to exclude from results
 */
/**
 * Order used to pick the NEXT card to review: most recently due first.
 *
 * Everything here is already filtered to `card.due <= now`, so descending means
 * "the card that came due most recently" — freshly-due cards are studied while
 * they are still fresh, and a long backlog sits at the back instead of gating
 * everything behind the oldest item.
 *
 * The trade-off is real: with a backlog that never empties, the oldest cards are
 * never reached. Flip to 1 here to go back to oldest-first; this constant is the
 * only place that decides it.
 *
 * Listing endpoints (`/all`, the list page, the debug dump) keep their own
 * ascending order — they show everything, so the head of the list is cosmetic.
 */
export const NEXT_DUE_SORT = { "card.due": -1 } as const;

export function buildNextDueQuery(excludeDomains: string[], excludeUrl?: string) {
  const query: any = {
    "card.due": { $lte: new Date() },
    url: { $exists: true, $ne: null },
  };
  if (excludeUrl) {
    query.url = { ...query.url, $nin: [excludeUrl] };
  }
  if (excludeDomains.length > 0) {
    query.url = {
      ...query.url,
      $not: new RegExp(excludeDomains.map((d) => d.replace(/\./g, "\\.")).join("|")),
    };
  }
  return query;
}
