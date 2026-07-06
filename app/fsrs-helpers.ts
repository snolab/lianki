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
