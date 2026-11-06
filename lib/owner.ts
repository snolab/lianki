/**
 * The owner gate for internal pages and routes (/dev, /api/dev, the dev bridge).
 *
 * The owner list lives ONLY in D1, table `site_role` (lib/site-role.ts; granted
 * and revoked at /dev/owners, no deploy). `isOwner` stays synchronous, because
 * it is called from dozens of places right after the session is read: it answers
 * from a snapshot of that list kept in this isolate, and `auth.api.getSession`
 * (auth.ts) refreshes the snapshot before it hands back a signed-in user. Code
 * that has no session (a webhook, an RPC) refreshes it itself or reads D1
 * directly (lib/owner-store.ts).
 *
 * **Fail closed**: no snapshot, or one older than OWNER_CACHE_MS, means nobody
 * is the owner. So a caller that forgot to refresh can only refuse an owner,
 * never admit anyone, and a revocation holds everywhere within OWNER_CACHE_MS.
 *
 * Exact address only (trimmed, lowercased); never the canonical form, so a
 * dot or a +tag on a Gmail address is someone else. Kept free of D1 and Next
 * imports so scripts can use it.
 */

/** The longest a revocation takes to reach a check in another isolate. */
export const OWNER_CACHE_MS = 30_000;
/**
 * A refresh reads D1 once the snapshot is this old: well before OWNER_CACHE_MS,
 * so a check made a moment after the session read cannot land on a snapshot
 * that has just expired and refuse the owner with a random 404.
 */
export const OWNER_REFRESH_MS = 20_000;

type Snapshot = { at: number; owners: string[] };
type State = { snapshot: Snapshot | null; generation: number };

// On globalThis: the bundler can instantiate this module once per layer (route
// handlers, server components, worker.ts), and a write in one must clear them all.
const KEY = Symbol.for("lianki.owner-snapshot");
const store = globalThis as unknown as Record<symbol, State | undefined>;
const state: State = (store[KEY] ??= { snapshot: null, generation: 0 });

export function normalizeEmail(email: string | null | undefined): string {
  return email?.trim().toLowerCase() ?? "";
}

/** The snapshot, or null when there is none or it is older than `maxAgeMs`. */
export function ownerSnapshot(maxAgeMs = OWNER_CACHE_MS, now = Date.now()): string[] | null {
  const s = state.snapshot;
  if (!s) return null;
  const age = now - s.at;
  return age >= 0 && age < maxAgeMs ? s.owners : null;
}

export function isOwner(email: string | null | undefined, now: number = Date.now()): boolean {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  return ownerSnapshot(OWNER_CACHE_MS, now)?.includes(normalized) ?? false;
}

/** The current generation: a read started before a clear must not fill the snapshot. */
export function ownerGeneration(): number {
  return state.generation;
}

/**
 * Store a list read from D1 at `at`. `generation` is ownerGeneration() from
 * before that read: a read older than the last clear, or than the stored
 * snapshot, is dropped. Also how unit tests set who the owner is.
 */
export function setOwnerSnapshot(
  owners: string[],
  at: number = Date.now(),
  generation: number = state.generation,
): void {
  if (generation !== state.generation) return;
  if (state.snapshot && state.snapshot.at > at) return;
  state.snapshot = { at, owners: owners.map(normalizeEmail).filter(Boolean) };
}

/** Forget the snapshot (after a grant or revoke here, on a failed read, between tests). */
export function clearOwnerCache(): void {
  state.snapshot = null;
  state.generation++;
}
