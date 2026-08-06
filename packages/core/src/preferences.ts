// Framework-agnostic preference types. Extracted from app/api/preferences/route.ts
// (a Next route) so the D1 repos / CF-native worker can import them cleanly.
// The route re-exports these for back-compat.
export type FilterType = "domain" | "title" | "url";

export interface FilterPattern {
  id: string;
  type: FilterType;
  pattern: string;
  isRegex: boolean;
  enabled: boolean;
  createdAt: string;
}

/**
 * Which due card to serve next.
 *
 * `oldest` — most overdue first (classic SRS: clear the backlog).
 * `newest` — least overdue first, i.e. whatever just came due.
 *
 * Both only ever consider cards that are already due; this reverses the order
 * within that set, it does not schedule anything early.
 */
export type ReviewOrder = "oldest" | "newest";

/**
 * The order everyone who never chooses gets, and the only place that decides it.
 *
 * "newest" — of the cards already due, study the one that came due most
 * recently, so a backlog does not gate every session behind its stalest item.
 * The trade-off is real: with a queue that never empties, the oldest cards are
 * never reached, which is exactly why the other order is offered rather than
 * argued about.
 */
export const DEFAULT_REVIEW_ORDER: ReviewOrder = "newest";

export const isReviewOrder = (v: unknown): v is ReviewOrder => v === "oldest" || v === "newest";

/** Coerce untrusted input, falling back to the default rather than throwing. */
export const asReviewOrder = (v: unknown): ReviewOrder =>
  isReviewOrder(v) ? v : DEFAULT_REVIEW_ORDER;

/** SQL fragment / Mongo direction for a given order. Single source of truth. */
export const reviewOrderSql = (o: ReviewOrder) => (o === "newest" ? "DESC" : "ASC");
export const reviewOrderMongo = (o: ReviewOrder): 1 | -1 => (o === "newest" ? -1 : 1);
