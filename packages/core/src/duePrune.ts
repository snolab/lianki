/**
 * Which locally-cached due cards can be proven deleted on the server.
 *
 * `prefetchDueCards` asks for a page of due cards and must reconcile deletions:
 * a card removed on the website otherwise stays in the local index forever and
 * keeps being served as "next". The hard part is that a page is a WINDOW, and
 * deleting anything outside it destroys cards that are merely out of view.
 *
 * Two earlier attempts got this wrong in opposite directions:
 *
 *  - Pruning only when the page came back short. With >= limit due cards the
 *    page is always full, so it never ran for the people actually affected.
 *  - Taking the last card as a horizon, assuming `/due` sorts ascending. That
 *    stopped being true when the sort became the user's reviewOrder preference:
 *    on "newest" the server returns the LEAST overdue cards, so the horizon was
 *    the earliest of those and every older card — the backlog the limit cut off
 *    — was deleted. Because deleting writes a fresh HLC, the resurrect guard
 *    then refused to restore them, permanently truncating the offline deck.
 *
 * So this makes no assumption about direction. The server returns a contiguous
 * run of due cards; whichever end it starts from, it returned everything due
 * between the earliest and latest date in the payload, and nothing outside that
 * span can be inferred at all.
 */
export type DueWindow = {
  /** Earliest due date the page covers, ms. */
  lo: number;
  /** Latest due date the page covers, ms. */
  hi: number;
  /** The page hit the limit, so cards may exist beyond `lo`/`hi`. */
  truncated: boolean;
};

export function dueWindow(dueMs: readonly number[], pageSize: number, limit: number): DueWindow {
  const finite = dueMs.filter((d) => Number.isFinite(d));
  return {
    lo: finite.length ? Math.min(...finite) : Infinity,
    hi: finite.length ? Math.max(...finite) : -Infinity,
    truncated: pageSize >= limit,
  };
}

/**
 * True only when the server's answer positively proves this card is gone.
 *
 * Fails SAFE everywhere else: an unreadable due date, or one outside the window
 * the page covers, keeps the card. A short page means the server ran out of due
 * cards rather than truncating, so the whole range is authoritative — including
 * an empty page, which means nothing is due and every local due card is stale.
 */
export function isProvablyDeleted(dueMs: number, w: DueWindow): boolean {
  if (!Number.isFinite(dueMs)) return false;
  if (!w.truncated) return true;
  // Strict bounds: a card exactly at either edge could have been cut by a tie
  // at the limit, so it is not provably gone.
  return dueMs > w.lo && dueMs < w.hi;
}
