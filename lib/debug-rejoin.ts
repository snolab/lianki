/**
 * Rejoining remote eval after a reload (docs/monitoring.md, "Remote eval",
 * "After a reload"). Two answers decide whether a page is a developer's: the
 * root layout's `isDev` (rendered into the page as `dev`) and the hub's, which
 * asked /api/debug/identity (`owner`, also `isDev`) when the socket opened.
 * Both read the permission snapshot, which fails closed: a request that finds
 * it missing or unreadable says "no" for that request only. Before this, one
 * such "no" stuck for the page's whole life — `dev` false made the page drop
 * every eval, a friend verdict from the hub put the owner's page in a thread of
 * its own (evals delivered to 0 pages, no pairing prompt) — and nothing asked
 * again until the next reload.
 *
 * Now either fresh "yes" counts, and a "no" the page has reason to doubt is
 * asked again a few times, then left alone. The hub still decides who gets
 * code: it sends an eval only to pages it put in the owner's thread.
 */

/**
 * Remote eval runs here: debug mode is on, and either the server rendered this
 * page for a `dev` holder or the hub (asked when the socket opened) put it in
 * the owner's thread. `hubOwner` is never true on a box (a box's own server
 * answers `dev` there) nor on a friend's page.
 */
export function mayRunEval(o: { debug: boolean; dev: boolean; hubOwner: boolean }): boolean {
  return o.debug && (o.dev || o.hubOwner);
}

/** The developer parts of the chat (pairings, sessions, full paths): the same rule, without debug mode. */
export const devParts = (o: { dev: boolean; hubOwner: boolean }): boolean => o.dev || o.hubOwner;

/** Waits before asking the hub again after a verdict that contradicts what this device knows. */
export const REJOIN_DELAYS_MS = [2_000, 8_000, 30_000] as const;

/**
 * localStorage (through storage-keys.ts, so also `lk:agent-was-owner`): this
 * device's page was last put in the owner's thread. Only a reason to ask the
 * hub again; it never grants anything.
 */
export const WAS_OWNER_KEY = "lk:debug-was-owner";

/**
 * The hub said this page is a friend's. Ask again (reconnect after the
 * returned ms) when the page has reason to doubt it — the server rendered it
 * for a `dev` holder, or this device was the owner's last time — and fewer
 * than REJOIN_DELAYS_MS.length tries were made on this page. null: accept it.
 */
export function rejoinDelay(o: { dev: boolean; wasOwner: boolean; tries: number }): number | null {
  if (!o.dev && !o.wasOwner) return null;
  return REJOIN_DELAYS_MS[o.tries] ?? null;
}
