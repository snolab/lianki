/**
 * `account_permission` (db/migrations/0058_account_permission.sql): who holds
 * `admin` and `dev` (lib/permissions.ts). Reads and writes over an injected D1,
 * so the Worker, the tests and the break-glass CLI (scripts/dev/permission.ts,
 * which inlines these same statements through wrangler) run one set of rules.
 * docs/secrets-and-auth.md, "Permissions".
 *
 * The last-admin guard is inside the UPDATE, one statement: two admins revoking
 * each other at once cannot both pass it. A write and its audit row go in one
 * batch (one transaction), and an audit row is added only if the write really
 * happened.
 */
import {
  clearPermissionCache,
  isPermission,
  normalizeEmail,
  type Grant,
  type Permission,
} from "./permissions";

type Stmt = {
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
};

export interface PermissionReadDb {
  prepare(query: string): {
    bind(...values: unknown[]): { all<T = Record<string, unknown>>(): Promise<{ results: T[] }> };
  };
}

export interface PermissionDb {
  prepare(query: string): { bind(...values: unknown[]): Stmt };
  batch(statements: never[]): Promise<unknown>;
}

export type GrantRow = {
  email: string;
  permission: Permission;
  granted_by: string;
  granted_at: number;
};

/** The longest address accepted (security_audit's detail holds 200 characters). */
export const MAX_PERMISSION_EMAIL = 180;

/** Active grants, oldest first: the first admin is "the owner" where only one account is meant. */
export const SQL_LIST = `SELECT email, permission, granted_by, granted_at FROM account_permission
  WHERE revoked_at IS NULL ORDER BY granted_at, email, permission`;

/**
 * ?1 email, ?2 permission, ?3 granted by, ?4 now. Reactivates a revoked row; an
 * active one is left alone, so a re-grant keeps the original granted_by and
 * granted_at (SQL_AUDIT_REGRANT records it in the audit only).
 */
export const SQL_GRANT = `INSERT INTO account_permission (email, permission, granted_by, granted_at)
  VALUES (?1, ?2, ?3, ?4)
  ON CONFLICT(email, permission) DO UPDATE SET granted_by = excluded.granted_by,
    granted_at = excluded.granted_at, revoked_at = NULL
  WHERE account_permission.revoked_at IS NOT NULL`;

/** ?1 email, ?2 permission, ?3 now. Never leaves no active admin. */
export const SQL_REVOKE = `UPDATE account_permission SET revoked_at = ?3
  WHERE email = ?1 AND permission = ?2 AND revoked_at IS NULL AND (?2 <> 'admin' OR EXISTS (
    SELECT 1 FROM account_permission AS other
    WHERE other.email <> ?1 AND other.permission = 'admin' AND other.revoked_at IS NULL))`;

/** ?1 email, ?2 permission, ?3 actor, ?4 now. Only if the grant above took effect. */
export const SQL_AUDIT_GRANT = `INSERT INTO security_audit (at_ms, kind, actor, detail)
  SELECT ?4, 'permission.grant', ?3, ?2 || ' ' || ?1 WHERE EXISTS (
    SELECT 1 FROM account_permission
    WHERE email = ?1 AND permission = ?2 AND granted_at = ?4 AND revoked_at IS NULL)`;

/**
 * ?1 email, ?2 permission, ?3 actor, ?4 now. A grant of a permission already held:
 * the row keeps its original grant, this audit row is the only trace.
 */
export const SQL_AUDIT_REGRANT = `INSERT INTO security_audit (at_ms, kind, actor, detail)
  SELECT ?4, 'permission.regrant', ?3, ?2 || ' ' || ?1 WHERE EXISTS (
    SELECT 1 FROM account_permission
    WHERE email = ?1 AND permission = ?2 AND granted_at <> ?4 AND revoked_at IS NULL)`;

/** ?1 email, ?2 permission, ?3 actor, ?4 now. Only if the revoke above took effect. */
export const SQL_AUDIT_REVOKE = `INSERT INTO security_audit (at_ms, kind, actor, detail)
  SELECT ?4, 'permission.revoke', ?3, ?2 || ' ' || ?1 WHERE EXISTS (
    SELECT 1 FROM account_permission WHERE email = ?1 AND permission = ?2 AND revoked_at = ?4)`;

const SQL_STATE =
  "SELECT granted_at, revoked_at FROM account_permission WHERE email = ?1 AND permission = ?2";

/** An address as it will be stored and compared, or null. Plus signs and dots stay as typed. */
export function validPermissionEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = normalizeEmail(raw);
  if (email.length > MAX_PERMISSION_EMAIL) return null;
  return /^[^\s@,;:"'<>()[\]\\]+@[^\s@,;:"'<>()[\]\\]+\.[^\s@,;:"'<>()[\]\\.]+$/.test(email)
    ? email
    : null;
}

/** Active grants, straight from D1. Throws on a D1 error. */
export async function listGrants(db: PermissionReadDb): Promise<GrantRow[]> {
  const { results } = await db.prepare(SQL_LIST).bind().all<GrantRow>();
  return results.filter((r) => isPermission(r.permission));
}

/** Active grants as the snapshot holds them. Throws on a D1 error. */
export async function readGrants(db: PermissionReadDb): Promise<Grant[]> {
  return (await listGrants(db)).map((r) => ({
    email: normalizeEmail(r.email),
    permission: r.permission,
  }));
}

/** Who holds `permission` right now, oldest grant first, straight from D1. Throws on a D1 error. */
export async function readHolders(db: PermissionReadDb, permission: Permission): Promise<string[]> {
  const out: string[] = [];
  for (const g of await readGrants(db))
    if (g.permission === permission && !out.includes(g.email)) out.push(g.email);
  return out;
}

/**
 * SQL: does the account whose id is in column `col` hold `permission` right now?
 * Exact address, as the snapshot compares them. For checks that must read D1
 * live in the same query (the box allowlist). `permission` is one of PERMISSIONS,
 * never user input.
 */
export function holdsSql(col: string, permission: Permission): string {
  if (!isPermission(permission)) throw new Error("bad permission");
  return `EXISTS (SELECT 1 FROM user pu JOIN account_permission pp ON pp.email = lower(trim(pu.email))
    WHERE pu.id = ${col} AND pp.permission = '${permission}' AND pp.revoked_at IS NULL)`;
}

/** The account ids (user.id) holding `permission` right now, by exact address. Throws on a D1 error. */
export async function holderIds(db: PermissionReadDb, permission: Permission): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT u.id AS id FROM user u WHERE ${holdsSql("u.id", permission)}`)
    .bind()
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

type FirstDb = {
  prepare(query: string): {
    bind(...values: unknown[]): { first<T = Record<string, unknown>>(): Promise<T | null> };
  };
};

/** Does this account (by user id) hold `permission` right now? Read live from D1, no cache. Throws on a D1 error. */
export async function userHolds(
  db: FirstDb,
  userId: string,
  permission: Permission,
): Promise<boolean> {
  const r = await db
    .prepare(`SELECT 1 AS ok FROM user u WHERE u.id = ?1 AND ${holdsSql("u.id", permission)}`)
    .bind(userId)
    .first<{ ok: number }>();
  return r?.ok === 1;
}

export type GrantResult = "granted" | "already-granted" | "bad-email" | "bad-permission";
export type RevokeResult =
  | "revoked"
  | "not-granted"
  | "last-admin"
  | "bad-email"
  | "bad-permission";

type RowState = { granted_at: number; revoked_at: number | null };
const rowState = (db: PermissionDb, email: string, permission: Permission) =>
  db.prepare(SQL_STATE).bind(email, permission).first<RowState>();

/** Grant by exact address. Says nothing about whether such an account exists. */
export async function grantPermission(
  db: PermissionDb,
  rawEmail: unknown,
  rawPermission: unknown,
  by: { id: string; email: string },
  now = Date.now(),
): Promise<GrantResult> {
  const email = validPermissionEmail(rawEmail);
  if (!email) return "bad-email";
  if (!isPermission(rawPermission)) return "bad-permission";
  await db.batch([
    db.prepare(SQL_GRANT).bind(email, rawPermission, normalizeEmail(by.email), now),
    db.prepare(SQL_AUDIT_GRANT).bind(email, rawPermission, by.id, now),
    db.prepare(SQL_AUDIT_REGRANT).bind(email, rawPermission, by.id, now),
  ] as never[]);
  clearPermissionCache();
  const row = await rowState(db, email, rawPermission);
  const done = row?.granted_at === now && row.revoked_at === null;
  if (done)
    console.log(
      JSON.stringify({ event: "permission.grant", permission: rawPermission, by: by.id }),
    );
  return done ? "granted" : "already-granted";
}

/** Revoke by exact address; `admin` is refused ("last-admin") when nobody would hold it. */
export async function revokePermission(
  db: PermissionDb,
  rawEmail: unknown,
  rawPermission: unknown,
  by: { id: string },
  now = Date.now(),
): Promise<RevokeResult> {
  const email = validPermissionEmail(rawEmail);
  if (!email) return "bad-email";
  if (!isPermission(rawPermission)) return "bad-permission";
  await db.batch([
    db.prepare(SQL_REVOKE).bind(email, rawPermission, now),
    db.prepare(SQL_AUDIT_REVOKE).bind(email, rawPermission, by.id, now),
  ] as never[]);
  clearPermissionCache();
  const row = await rowState(db, email, rawPermission);
  if (row?.revoked_at === now) {
    console.log(
      JSON.stringify({ event: "permission.revoke", permission: rawPermission, by: by.id }),
    );
    return "revoked";
  }
  return !row || row.revoked_at !== null ? "not-granted" : "last-admin";
}

/** The audit kinds of /dev/permissions' history, as security_audit holds them. */
export const HISTORY_KINDS = ["permission.grant", "permission.revoke", "permission.regrant"];
export type HistoryAction = "grant" | "revoke" | "regrant";

export type HistoryRow = {
  id: number;
  at: number;
  action: HistoryAction;
  permission: string;
  email: string;
  /** The acting admin's address, or the raw actor when no account matches it (`cli`). */
  by: string;
  source: "cli" | "ui";
};

/** One page of history and the cursor for the next (older) page, or null at the end. */
export type HistoryPage = { rows: HistoryRow[]; next: number | null };

export const HISTORY_PAGE = 50;

/** ?1 the id to page below (null: newest), ?2 page size + 1. Newest first. */
export const SQL_HISTORY = `SELECT a.id AS id, a.at_ms AS at, a.kind AS kind, a.actor AS actor,
    a.detail AS detail, u.email AS actor_email
  FROM security_audit a LEFT JOIN user u ON u.id = a.actor
  WHERE a.kind IN (${HISTORY_KINDS.map((k) => `'${k}'`).join(", ")})
    AND (?1 IS NULL OR a.id < ?1)
  ORDER BY a.id DESC LIMIT ?2`;

type HistoryDbRow = {
  id: number;
  at: number;
  kind: string;
  actor: string;
  detail: string | null;
  actor_email: string | null;
};

/**
 * Grants, re-grants and revokes from security_audit, newest first, `limit` a
 * page (at most 200). `before` is the `next` of the previous page. The CLI's
 * actor is `cli`; anything else is a user id, shown by its address. Throws on a
 * D1 error.
 */
export async function readPermissionHistory(
  db: PermissionReadDb,
  before: number | null = null,
  limit = HISTORY_PAGE,
): Promise<HistoryPage> {
  const size = Math.max(1, Math.min(200, Math.trunc(limit) || HISTORY_PAGE));
  const cursor = before !== null && Number.isFinite(before) ? Math.trunc(before) : null;
  const { results } = await db
    .prepare(SQL_HISTORY)
    .bind(cursor, size + 1)
    .all<HistoryDbRow>();
  const rows = results.slice(0, size).map((r): HistoryRow => {
    const [permission = "", ...rest] = (r.detail ?? "").split(" ");
    return {
      id: r.id,
      at: r.at,
      action: r.kind.slice("permission.".length) as HistoryAction,
      permission,
      email: rest.join(" "),
      by: r.actor_email ? normalizeEmail(r.actor_email) : r.actor,
      source: r.actor === "cli" ? "cli" : "ui",
    };
  });
  return { rows, next: results.length > size ? rows[rows.length - 1].id : null };
}
