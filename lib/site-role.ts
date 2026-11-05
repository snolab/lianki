/**
 * `site_role` (db/migrations/0047_site_role.sql): the owner list. Reads and
 * writes over an injected D1, so the Worker, the tests and the break-glass CLI
 * (scripts/dev/owner-role.ts, which inlines these same statements through
 * wrangler) all run one set of rules. docs/secrets-and-auth.md, "The owner role".
 *
 * The last-owner guard is inside the UPDATE, one statement: two owners revoking
 * each other at once cannot both pass it. A role write and its audit row go in
 * one batch (one transaction), so no change goes unrecorded, and an audit row is
 * added only if the write really happened.
 */
import { clearOwnerCache, normalizeEmail } from "./owner";

type Stmt = {
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
};

export interface OwnerReadDb {
  prepare(query: string): {
    bind(...values: unknown[]): { all<T = Record<string, unknown>>(): Promise<{ results: T[] }> };
  };
}

export interface SiteRoleDb {
  prepare(query: string): { bind(...values: unknown[]): Stmt };
  batch(statements: never[]): Promise<unknown>;
}

export type OwnerRow = {
  email: string;
  granted_by: string;
  granted_at: number;
};

/** The longest address accepted (security_audit's detail holds 200 characters). */
export const MAX_OWNER_EMAIL = 200;

/**
 * Active owners, oldest grant first; the first is "the owner" where only one
 * account can be meant (the dev bridge, the dev server's sign-in).
 */
export const SQL_LIST = `SELECT email, granted_by, granted_at FROM site_role
  WHERE role = 'owner' AND revoked_at IS NULL ORDER BY granted_at, email`;

/** ?1 email, ?2 granted by, ?3 now. Reactivates a revoked row; an active one is left alone. */
export const SQL_GRANT = `INSERT INTO site_role (email, role, granted_by, granted_at)
  VALUES (?1, 'owner', ?2, ?3)
  ON CONFLICT(email) DO UPDATE SET granted_by = excluded.granted_by,
    granted_at = excluded.granted_at, revoked_at = NULL
  WHERE site_role.revoked_at IS NOT NULL`;

/** ?1 email, ?2 now. Touches nothing when it would leave no active owner. */
export const SQL_REVOKE = `UPDATE site_role SET revoked_at = ?2
  WHERE email = ?1 AND revoked_at IS NULL AND EXISTS (
    SELECT 1 FROM site_role AS other
    WHERE other.email <> ?1 AND other.role = 'owner' AND other.revoked_at IS NULL)`;

/** ?1 email, ?2 actor, ?3 now. Only if the grant above took effect. */
export const SQL_AUDIT_GRANT = `INSERT INTO security_audit (at_ms, kind, actor, detail)
  SELECT ?3, 'site-role.grant', ?2, ?1 WHERE EXISTS (
    SELECT 1 FROM site_role WHERE email = ?1 AND granted_at = ?3 AND revoked_at IS NULL)`;

/** ?1 email, ?2 actor, ?3 now. Only if the revoke above took effect. */
export const SQL_AUDIT_REVOKE = `INSERT INTO security_audit (at_ms, kind, actor, detail)
  SELECT ?3, 'site-role.revoke', ?2, ?1 WHERE EXISTS (
    SELECT 1 FROM site_role WHERE email = ?1 AND revoked_at = ?3)`;

const SQL_STATE = "SELECT granted_at, revoked_at FROM site_role WHERE email = ?1";

/**
 * An address as it will be stored and compared, or null. Plus signs and dots
 * are kept as typed: this is the exact address, never folded.
 */
export function validOwnerEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = normalizeEmail(raw);
  if (email.length > MAX_OWNER_EMAIL) return null;
  return /^[^\s@,;:"<>()[\]\\]+@[^\s@,;:"<>()[\]\\]+\.[^\s@,;:"<>()[\]\\.]+$/.test(email)
    ? email
    : null;
}

/** Active owners' rows, straight from D1. Throws on a D1 error. */
export async function listOwners(db: OwnerReadDb): Promise<OwnerRow[]> {
  const { results } = await db.prepare(SQL_LIST).bind().all<OwnerRow>();
  return results;
}

/** Active owners' addresses, straight from D1. Throws on a D1 error. */
export async function readOwnerEmails(db: OwnerReadDb): Promise<string[]> {
  return (await listOwners(db)).map((r) => normalizeEmail(r.email));
}

export type GrantResult = "granted" | "already-owner" | "bad-email";
export type RevokeResult = "revoked" | "not-owner" | "last-owner" | "bad-email";

type RoleState = { granted_at: number; revoked_at: number | null };
const roleState = (db: SiteRoleDb, email: string) =>
  db.prepare(SQL_STATE).bind(email).first<RoleState>();

/** Grant by exact address. Says nothing about whether such an account exists. */
export async function grantOwner(
  db: SiteRoleDb,
  rawEmail: unknown,
  by: { id: string; email: string },
  now = Date.now(),
): Promise<GrantResult> {
  const email = validOwnerEmail(rawEmail);
  if (!email) return "bad-email";
  await db.batch([
    db.prepare(SQL_GRANT).bind(email, normalizeEmail(by.email), now),
    db.prepare(SQL_AUDIT_GRANT).bind(email, by.id, now),
  ] as never[]);
  clearOwnerCache();
  const row = await roleState(db, email);
  const done = row?.granted_at === now && row.revoked_at === null;
  if (done) console.log(JSON.stringify({ event: "site-role.grant", by: by.id }));
  return done ? "granted" : "already-owner";
}

/** Revoke by exact address; refused ("last-owner") when nobody would be left. */
export async function revokeOwner(
  db: SiteRoleDb,
  rawEmail: unknown,
  by: { id: string },
  now = Date.now(),
): Promise<RevokeResult> {
  const email = validOwnerEmail(rawEmail);
  if (!email) return "bad-email";
  await db.batch([
    db.prepare(SQL_REVOKE).bind(email, now),
    db.prepare(SQL_AUDIT_REVOKE).bind(email, by.id, now),
  ] as never[]);
  clearOwnerCache();
  const row = await roleState(db, email);
  if (row?.revoked_at === now) {
    console.log(JSON.stringify({ event: "site-role.revoke", by: by.id }));
    return "revoked";
  }
  return !row || row.revoked_at !== null ? "not-owner" : "last-owner";
}
