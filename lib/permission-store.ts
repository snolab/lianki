/**
 * Keeps the permission snapshot (lib/permissions.ts) fresh from D1, the way
 * lib/owner-store.ts keeps the owner one: one small query, at most once per
 * PERMISSION_REFRESH_MS per isolate; concurrent misses each do their own read
 * (a Worker must not await another request's I/O).
 *
 * **Fail closed**: off the D1 backend, or when the read throws (a missing
 * table included), the snapshot is dropped and nobody holds anything for that
 * call; never a crash. A failure is logged and not remembered.
 */
import { dbBackend, getD1 } from "@/lib/d1";
import {
  PERMISSION_CACHE_MS,
  PERMISSION_REFRESH_MS,
  clearPermissionCache,
  permissionGeneration,
  permissionSnapshot,
  setPermissionSnapshot,
  type Grant,
} from "./permissions";
import { type PermissionReadDb, readGrants } from "./account-permission";

function defaultDb(): PermissionReadDb | null {
  return dbBackend() === "d1" ? (getD1() as unknown as PermissionReadDb) : null;
}

/** The active grants, oldest first, at most PERMISSION_CACHE_MS old; [] when unreadable. Never throws. */
export async function refreshPermissions(
  db: () => PermissionReadDb | null = defaultDb,
  now: () => number = Date.now,
): Promise<Grant[]> {
  const t = now();
  const cached = permissionSnapshot(PERMISSION_REFRESH_MS, t);
  if (cached) return cached;
  const generation = permissionGeneration();
  try {
    const d1 = db();
    const grants = d1 ? await readGrants(d1) : [];
    if (now() - t >= PERMISSION_CACHE_MS) {
      console.error(JSON.stringify({ event: "permissions.read-stale", ms: now() - t }));
      clearPermissionCache();
      return [];
    }
    setPermissionSnapshot(grants, t, generation);
    return grants;
  } catch (e) {
    console.error(JSON.stringify({ event: "permissions.read-failed", error: String(e) }));
    clearPermissionCache();
    return [];
  }
}

/** refreshPermissions for code that holds its own D1 and has no session (a webhook). */
export const refreshPermissionsFrom = (d1: unknown): Promise<Grant[]> =>
  refreshPermissions(() => d1 as PermissionReadDb);
