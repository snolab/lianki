/**
 * Permission checks: the ONE gate for every owner / dev / admin surface
 * (docs/secrets-and-auth.md, "Permissions"). Two permissions, held per account
 * as rows in D1 (`account_permission`, db/migrations/0058_account_permission.sql,
 * lib/account-permission.ts), granted and revoked at /dev/permissions:
 *
 * - `admin` — manages people, money and grants: /dev/permissions, users,
 *   credits, membership, gift codes, friends, flags, box clients, payment test
 *   mode.
 * - `dev`   — development tools and dark features: every other /dev page and
 *   /api/dev route, the dev bridge, live view, the owner chat thread, features
 *   shipped dark behind a flag.
 *
 * Neither implies the other: each is its own grant. Never an email list in code
 * or env (AGENTS.md hard rules).
 *
 * `isAdmin` / `isDev` stay synchronous, like the old isOwner: they answer from a
 * snapshot of the grants kept in this isolate, refreshed by
 * `auth.api.getSession` (auth.ts → lib/owner-store.ts → lib/permission-store.ts)
 * before a signed-in user is handed back.
 *
 * **Fail closed**: no snapshot, or one older than PERMISSION_CACHE_MS, grants
 * nothing. A revocation holds everywhere within PERMISSION_CACHE_MS.
 *
 * MIGRATION (step a, 2026-11-09): an active owner in `site_role` (lib/owner.ts)
 * still passes both checks, so nothing changes until the grants are seeded.
 * Step c removes that fallback, lib/owner.ts and site_role.
 *
 * Exact address only (trimmed, lowercased), never the canonical form. Kept free
 * of D1 and Next imports so scripts can use it.
 */
import { isOwner, normalizeEmail, ownerSnapshot } from "./owner";

export const PERMISSIONS = ["admin", "dev"] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const isPermission = (v: unknown): v is Permission =>
  typeof v === "string" && (PERMISSIONS as readonly string[]).includes(v);

/** The longest a revocation takes to reach a check in another isolate. */
export const PERMISSION_CACHE_MS = 30_000;
/** A refresh reads D1 once the snapshot is this old (well inside the cache window). */
export const PERMISSION_REFRESH_MS = 20_000;

/** One active grant, oldest first in a snapshot. */
export type Grant = { email: string; permission: Permission };

type Snapshot = { at: number; grants: Grant[] };
type State = { snapshot: Snapshot | null; generation: number };

// On globalThis: the bundler can instantiate this module once per layer, and a
// write in one must clear them all.
const KEY = Symbol.for("lianki.permission-snapshot");
const store = globalThis as unknown as Record<symbol, State | undefined>;
const state: State = (store[KEY] ??= { snapshot: null, generation: 0 });

export { normalizeEmail };

/** The grants, oldest first, or null when there is no fresh snapshot. */
export function permissionSnapshot(
  maxAgeMs = PERMISSION_CACHE_MS,
  now = Date.now(),
): Grant[] | null {
  const s = state.snapshot;
  if (!s) return null;
  const age = now - s.at;
  return age >= 0 && age < maxAgeMs ? s.grants : null;
}

/** Does this address hold `permission` right now? Fails closed. */
export function hasPermission(
  email: string | null | undefined,
  permission: Permission,
  now: number = Date.now(),
): boolean {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  const grants = permissionSnapshot(PERMISSION_CACHE_MS, now);
  if (grants?.some((g) => g.email === normalized && g.permission === permission)) return true;
  // Step a only: the old owner role still passes. Removed in step c.
  return isOwner(normalized, now);
}

/** Manages people, money and permission grants. */
export const isAdmin = (email: string | null | undefined, now?: number): boolean =>
  hasPermission(email, "admin", now);

/** Development tools and features shipped dark. */
export const isDev = (email: string | null | undefined, now?: number): boolean =>
  hasPermission(email, "dev", now);

/**
 * Who holds `permission` right now, oldest grant first; [] when unknown (fail
 * closed). For the "who can see this page" line on /dev pages.
 */
export function permissionHolders(permission: Permission, now = Date.now()): string[] {
  const out: string[] = [];
  for (const g of permissionSnapshot(PERMISSION_CACHE_MS, now) ?? [])
    if (g.permission === permission && !out.includes(g.email)) out.push(g.email);
  // Step a only: the old owners pass every check, so they are listed too.
  for (const o of ownerSnapshot(PERMISSION_CACHE_MS, now) ?? []) if (!out.includes(o)) out.push(o);
  return out;
}

/** The current generation: a read started before a clear must not fill the snapshot. */
export function permissionGeneration(): number {
  return state.generation;
}

/**
 * Store grants read from D1 at `at`. `generation` is permissionGeneration() from
 * before that read: a read older than the last clear, or than the stored
 * snapshot, is dropped. Also how unit tests set who holds what.
 */
export function setPermissionSnapshot(
  grants: Grant[],
  at: number = Date.now(),
  generation: number = state.generation,
): void {
  if (generation !== state.generation) return;
  if (state.snapshot && state.snapshot.at > at) return;
  state.snapshot = {
    at,
    grants: grants
      .map((g) => ({ email: normalizeEmail(g.email), permission: g.permission }))
      .filter((g) => g.email && isPermission(g.permission)),
  };
}

/** Forget the snapshot (after a grant or revoke here, on a failed read, between tests). */
export function clearPermissionCache(): void {
  state.snapshot = null;
  state.generation++;
}
