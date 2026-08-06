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
// The order used to pick the NEXT card is no longer a constant: it is the
// per-user `reviewOrder` preference, resolved once per request by dueSort() in
// app/fsrs.ts and mapped by reviewOrderMongo/reviewOrderSql. What everyone who
// never chooses gets — and why — is documented on DEFAULT_REVIEW_ORDER in
// packages/core/src/preferences.ts.
//
// Listing endpoints (`/all`, the list page, the debug dump) keep their own
// ascending order — they show everything, so the head of the list is cosmetic.

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
