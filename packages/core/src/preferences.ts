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

/**
 * Whether to record watch time at all.
 *
 * Watch tracking measures per-video viewing on every site the user visits, so
 * it needs a switch the user can reach — not only the compile-time constants
 * that decide what *counts* once recording is on. The Chrome Web Store asks
 * what data an extension collects and whether the user can decline; "no" is a
 * hard answer to defend for behavioural data gathered everywhere.
 *
 * Defaults to on, because the feature is why the streaks and heatmap have
 * anything in them, and turning it off silently would be its own surprise.
 */
export const DEFAULT_WATCH_TRACKING = true;

/** Coerce untrusted input; anything but an explicit `false` means on. */
export const asWatchTracking = (v: unknown): boolean =>
  v === undefined || v === null ? DEFAULT_WATCH_TRACKING : v !== false;

/** SQL fragment / Mongo direction for a given order. Single source of truth. */
export const reviewOrderSql = (o: ReviewOrder) => (o === "newest" ? "DESC" : "ASC");
export const reviewOrderMongo = (o: ReviewOrder): 1 | -1 => (o === "newest" ? -1 : 1);
