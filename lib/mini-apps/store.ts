/**
 * Mini apps' D1 rows (db/migrations/0078_mini_apps.sql) and R2 keys. Every
 * query is scoped by the caller's own account id; nothing names another
 * account's app.
 */
import type { CapabilityId } from "./capabilities";
import { type Decision, type Grants, grantsOf } from "./grants";
import type { Manifest } from "./manifest";

export type MiniStmt = {
  bind(...v: unknown[]): MiniStmt;
  all<T>(): Promise<{ results: T[] }>;
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
};
export type MiniDb = { prepare(sql: string): MiniStmt; batch(s: MiniStmt[]): Promise<unknown> };

export const MINI_PREFIX = "mini-apps/";

/** A user id safe in a key (better-auth ids are [A-Za-z0-9]). */
const safeUser = (u: string) => {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(u)) throw new Error("bad user id");
  return u;
};
export const htmlKey = (uid: string, slug: string) =>
  `${MINI_PREFIX}${safeUser(uid)}/${slug}/index.html`;
export const manifestKey = (uid: string, slug: string) =>
  `${MINI_PREFIX}${safeUser(uid)}/${slug}/manifest.json`;

export const newAppId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 16);

export type MiniApp = Manifest & {
  id: string;
  ownerId: string;
  size: number;
  sha256: string;
  r2Key: string;
  createdMs: number;
  updatedMs: number;
};

type Row = {
  id: string;
  owner_id: string;
  slug: string;
  name: string;
  icon: string;
  version: string;
  permissions: string;
  size: number;
  sha256: string;
  r2_key: string;
  created_ms: number;
  updated_ms: number;
};
const COLS =
  "id, owner_id, slug, name, icon, version, permissions, size, sha256, r2_key, created_ms, updated_ms";
const perms = (raw: string): CapabilityId[] => {
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
};
const app = (r: Row): MiniApp => ({
  id: r.id,
  ownerId: r.owner_id,
  slug: r.slug,
  name: r.name,
  icon: r.icon,
  version: r.version,
  permissions: perms(r.permissions),
  size: Number(r.size),
  sha256: r.sha256,
  r2Key: r.r2_key,
  createdMs: Number(r.created_ms),
  updatedMs: Number(r.updated_ms),
});

export async function listApps(db: MiniDb, ownerId: string): Promise<MiniApp[]> {
  const { results } = await db
    .prepare(`SELECT ${COLS} FROM mini_app WHERE owner_id = ? ORDER BY updated_ms DESC LIMIT 500`)
    .bind(ownerId)
    .all<Row>();
  return results.map(app);
}

export async function getApp(db: MiniDb, ownerId: string, slug: string): Promise<MiniApp | null> {
  const r = await db
    .prepare(`SELECT ${COLS} FROM mini_app WHERE owner_id = ? AND slug = ?`)
    .bind(ownerId, slug)
    .first<Row>();
  return r ? app(r) : null;
}

/**
 * Insert or replace the app's row (a republish keeps its id, so its grants
 * and storage stay), refused past `perAccount` apps. True when written.
 */
export async function upsertApp(
  db: MiniDb,
  a: Omit<MiniApp, "createdMs" | "updatedMs" | "id"> & { id: string; now: number },
  perAccount: number,
): Promise<boolean> {
  const r = await db
    .prepare(
      `INSERT INTO mini_app (${COLS})
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11
       WHERE EXISTS (SELECT 1 FROM mini_app WHERE owner_id = ?2 AND slug = ?3)
          OR (SELECT COUNT(*) FROM mini_app WHERE owner_id = ?2) < ?12
       ON CONFLICT (owner_id, slug) DO UPDATE SET name = excluded.name, icon = excluded.icon,
         version = excluded.version, permissions = excluded.permissions, size = excluded.size,
         sha256 = excluded.sha256, r2_key = excluded.r2_key, updated_ms = excluded.updated_ms
       RETURNING id`,
    )
    .bind(
      a.id,
      a.ownerId,
      a.slug,
      a.name,
      a.icon,
      a.version,
      JSON.stringify(a.permissions),
      a.size,
      a.sha256,
      a.r2Key,
      a.now,
      perAccount,
    )
    .first<{ id: string }>();
  return !!r;
}

/** The app, its grants and its storage, gone. */
export async function deleteApp(db: MiniDb, a: MiniApp) {
  await db.batch([
    db
      .prepare("DELETE FROM mini_app_grant WHERE owner_id = ? AND app_id = ?")
      .bind(a.ownerId, a.id),
    db.prepare("DELETE FROM mini_app_kv WHERE app_id = ?").bind(a.id),
    db.prepare("DELETE FROM mini_app WHERE owner_id = ? AND id = ?").bind(a.ownerId, a.id),
  ]);
}

export async function grantsFor(db: MiniDb, ownerId: string, appId: string): Promise<Grants> {
  const { results } = await db
    .prepare("SELECT permission, decision FROM mini_app_grant WHERE owner_id = ? AND app_id = ?")
    .bind(ownerId, appId)
    .all<{ permission: string; decision: string }>();
  return grantsOf(results);
}

export async function setGrant(
  db: MiniDb,
  ownerId: string,
  appId: string,
  permission: CapabilityId,
  decision: Decision,
  now: number,
) {
  await db
    .prepare(
      `INSERT INTO mini_app_grant (owner_id, app_id, permission, decision, created_ms) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (owner_id, app_id, permission) DO UPDATE SET decision = excluded.decision, created_ms = excluded.created_ms`,
    )
    .bind(ownerId, appId, permission, decision, now)
    .run();
}

export async function revokeGrant(db: MiniDb, ownerId: string, appId: string, permission: string) {
  await db
    .prepare("DELETE FROM mini_app_grant WHERE owner_id = ? AND app_id = ? AND permission = ?")
    .bind(ownerId, appId, permission)
    .run();
}

/** Spend a one-time grant: true once. */
export async function spendOnce(db: MiniDb, ownerId: string, appId: string, permission: string) {
  const r = await db
    .prepare(
      "DELETE FROM mini_app_grant WHERE owner_id = ? AND app_id = ? AND permission = ? AND decision = 'once' RETURNING permission",
    )
    .bind(ownerId, appId, permission)
    .first<{ permission: string }>();
  return !!r;
}

// ── lianki.storage ──────────────────────────────────────────────────────────

export const KV_KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const utf8 = (s: string) => new TextEncoder().encode(s).length;

export async function kvGet(db: MiniDb, appId: string, key: string): Promise<unknown> {
  const r = await db
    .prepare("SELECT value FROM mini_app_kv WHERE app_id = ? AND key = ?")
    .bind(appId, key)
    .first<{ value: string }>();
  return r ? JSON.parse(r.value) : null;
}

/** The app's keys (and the bytes it uses), up to `limit`. */
export async function kvList(db: MiniDb, appId: string, prefix = "", limit = 200) {
  const { results } = await db
    .prepare(
      "SELECT key FROM mini_app_kv WHERE app_id = ? AND substr(key, 1, ?) = ? ORDER BY key LIMIT ?",
    )
    .bind(appId, prefix.length, prefix, limit)
    .all<{ key: string }>();
  const used = await db
    .prepare("SELECT COALESCE(SUM(bytes), 0) AS n FROM mini_app_kv WHERE app_id = ?")
    .bind(appId)
    .first<{ n: number }>();
  return { keys: results.map((r) => r.key), bytes: Number(used?.n ?? 0) };
}

/** Write (or with null, delete) one value; false when it would pass `cap` bytes for this app. */
export async function kvSet(
  db: MiniDb,
  appId: string,
  key: string,
  value: unknown,
  cap: number,
  now: number,
): Promise<boolean> {
  if (value === null || value === undefined) {
    await db.prepare("DELETE FROM mini_app_kv WHERE app_id = ? AND key = ?").bind(appId, key).run();
    return true;
  }
  const json = JSON.stringify(value);
  const bytes = utf8(key) + utf8(json);
  const r = await db
    .prepare(
      `INSERT INTO mini_app_kv (app_id, key, value, bytes, updated_ms)
       SELECT ?1, ?2, ?3, ?4, ?5
       WHERE (SELECT COALESCE(SUM(bytes), 0) FROM mini_app_kv WHERE app_id = ?1 AND key != ?2) + ?4 <= ?6
       ON CONFLICT (app_id, key) DO UPDATE SET value = excluded.value, bytes = excluded.bytes, updated_ms = excluded.updated_ms
       RETURNING key`,
    )
    .bind(appId, key, json, bytes, now, cap)
    .first<{ key: string }>();
  return !!r;
}
