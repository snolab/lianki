/**
 * Keeps the owner snapshot (lib/owner.ts) fresh from D1, the way
 * lib/flags-store.ts keeps flags: one small query, at most once per
 * OWNER_REFRESH_MS per isolate, except that nothing is shared between requests
 * in flight (a Worker must not await another request's I/O, and an auth check
 * should not depend on it), so concurrent misses each do their own read.
 *
 * **Fail closed**: off the D1 backend, or when the read throws, the snapshot is
 * dropped and nobody is the owner for that call; never a crash. A failure is
 * logged and not remembered, so the next call tries again.
 */
import { dbBackend, getD1 } from "@/lib/d1";
import {
  OWNER_CACHE_MS,
  OWNER_REFRESH_MS,
  clearOwnerCache,
  ownerGeneration,
  ownerSnapshot,
  setOwnerSnapshot,
} from "./owner";
import { type OwnerReadDb, readOwnerEmails } from "./site-role";

function defaultDb(): OwnerReadDb | null {
  return dbBackend() === "d1" ? (getD1() as unknown as OwnerReadDb) : null;
}

/** refreshOwners for code that holds its own D1 and has no session (a webhook). */
export const refreshOwnersFrom = (d1: unknown): Promise<string[]> =>
  refreshOwners(() => d1 as OwnerReadDb);

/**
 * The active owners, oldest grant first, at most OWNER_CACHE_MS old; [] when
 * they cannot be read. Never throws. `db` and `now` are for callers without a
 * Next request (a webhook) and for tests.
 */
export async function refreshOwners(
  db: () => OwnerReadDb | null = defaultDb,
  now: () => number = Date.now,
): Promise<string[]> {
  const t = now();
  const cached = ownerSnapshot(OWNER_REFRESH_MS, t);
  if (cached) return cached;
  const generation = ownerGeneration();
  try {
    const d1 = db();
    const owners = d1 ? await readOwnerEmails(d1) : [];
    // Held past the window, the answer may predate a revocation: too old to act on.
    if (now() - t >= OWNER_CACHE_MS) {
      console.error(JSON.stringify({ event: "owners.read-stale", ms: now() - t }));
      clearOwnerCache();
      return [];
    }
    setOwnerSnapshot(owners, t, generation);
    return owners;
  } catch (e) {
    console.error(JSON.stringify({ event: "owners.read-failed", error: String(e) }));
    clearOwnerCache();
    return [];
  }
}
