/**
 * Purge queue: how the site tells the userscript that cards are gone.
 *
 * Deleting a card touches three stores, not two. The /data page knows about the
 * cloud (Mongo/D1) and the browser's IndexedDB mirror — but the userscript keeps
 * its OWN copy in GM storage, which is the one it serves cards from when it
 * picks what to review next. Nothing ever removed cards from it: the only pull
 * from the server (`prefetchDueCards`) upserts the top-20 due cards and cannot
 * distinguish "deleted" from "not in this page of results". So a card deleted on
 * the site kept being served, and re-appeared in the mirror on the next sync,
 * because `syncToSiteDB` rewrites IndexedDB *from* GM storage.
 *
 * The site cannot reach GM storage directly, so it leaves a note here instead.
 * The userscript drains it the next time it runs on lianki.com — which is
 * immediately, since the /data page is itself lianki.com.
 *
 * STOPGAP. This only propagates site → userscript, only in this browser, and
 * only while the queue survives. The real fix is soft deletes that replicate
 * through the sync protocol — specified in docs/sync-merge-rules.md. Delete this
 * module and its call sites once tombstones land; do not build on it.
 */

export const PURGE_KEY = "lk:purge";

export type PurgeRequest = {
  /** Specific urls to forget. */
  urls: string[];
  /** Forget everything — used by "delete all", where listing every url is silly. */
  all?: boolean;
  ts: number;
};

/**
 * Queue urls for the userscript to forget. Merges with anything still pending,
 * because two deletes in a row must not lose the first one.
 */
export function queuePurge(urls: string[], opts: { all?: boolean } = {}): void {
  if (typeof localStorage === "undefined") return;
  if (!urls.length && !opts.all) return;
  try {
    const prev = readPurge();
    const merged: PurgeRequest = {
      urls: [...new Set([...(prev?.urls ?? []), ...urls])],
      all: opts.all || prev?.all || undefined,
      ts: Date.now(),
    };
    localStorage.setItem(PURGE_KEY, JSON.stringify(merged));
  } catch {
    // A private window with storage disabled just means the userscript keeps
    // its stale copy; deleting from the cloud still worked.
  }
}

export function readPurge(): PurgeRequest | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(PURGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PurgeRequest;
    if (!parsed || !Array.isArray(parsed.urls)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearPurge(): void {
  try {
    localStorage?.removeItem(PURGE_KEY);
  } catch {}
}
