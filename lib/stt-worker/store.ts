/**
 * Lianki's speech servers for other accounts (docs/local-stt.md, "Lianki's
 * speech servers for everyone"; flag stt.worker): who may use them
 * (`stt_access`, default deny) and which speech servers may register
 * (`stt_worker`, Ed25519 public keys). Tables: db/migrations/0073_stt_worker.sql.
 *
 * Every change is in security_audit (ids only, never an email or a key). The
 * allowlist is managed at /dev/stt-access (admin); workers are added by the
 * break-glass CLI after the owner's approval and can be revoked on the page.
 */
import { audit, type AuditDb } from "@/lib/security/audit-log";

type Stmt = {
  bind(...v: unknown[]): {
    first<T>(): Promise<T | null>;
    all<T>(): Promise<{ results: T[] }>;
    run(): Promise<unknown>;
  };
};
export type SttDb = { prepare(q: string): Stmt } & AuditDb;

const changes = (r: unknown) => Number((r as { meta?: { changes?: number } })?.meta?.changes ?? 0);

/* ------------------------------------------------------------ the allowlist */

/** Most accounts one search returns. */
export const USER_SEARCH_LIMIT = 10;

/**
 * Accounts whose name or email contains `q` (case-insensitive, LIKE with its
 * wildcards escaped), for the admin's picker on /dev/stt-access. Two
 * characters at least; nothing else about the account.
 */
export async function searchUsers(
  db: SttDb,
  q: string,
): Promise<{ id: string; name: string | null; email: string }[]> {
  const t = q.trim().slice(0, 100);
  if (t.length < 2) return [];
  const like = `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const r = await db
    .prepare(
      `SELECT id, name, email FROM user
       WHERE name LIKE ?1 ESCAPE '\\' OR email LIKE ?1 ESCAPE '\\'
       ORDER BY name LIMIT ${USER_SEARCH_LIMIT}`,
    )
    .bind(like)
    .all<{ id: string; name: string | null; email: string }>();
  return r.results ?? [];
}

/** Whether this account may use Lianki's speech servers. A failed read is "no". */
export async function sttAllowed(db: SttDb, userId: string): Promise<boolean> {
  if (!userId) return false;
  try {
    const r = await db
      .prepare("SELECT 1 AS ok FROM stt_access WHERE user_id = ?1")
      .bind(userId)
      .first<{ ok: number }>();
    return r?.ok === 1;
  } catch {
    return false;
  }
}

export type SttAccessRow = {
  userId: string;
  name: string | null;
  addedBy: string;
  addedAt: number;
};

/**
 * The allowlist, newest first, with each account's display name (the admin
 * page). Never the email: the page shows a name or the account id.
 */
export async function listSttAccess(db: SttDb): Promise<SttAccessRow[]> {
  const { results } = await db
    .prepare(
      `SELECT a.user_id AS userId, u.name AS name, a.added_by AS addedBy,
              a.added_at AS addedAt
       FROM stt_access a LEFT JOIN user u ON u.id = a.user_id ORDER BY a.added_at DESC`,
    )
    .bind()
    .all<SttAccessRow>();
  return results;
}

/** Add an account by email or id. Its id, or null when there is no such account. */
export async function allowSttUser(
  db: SttDb,
  emailOrId: string,
  by: string,
  now = Date.now(),
): Promise<string | null> {
  const who = emailOrId.trim();
  if (!who) return null;
  const u = await db
    .prepare(
      who.includes("@")
        ? "SELECT id FROM user WHERE email = ?1 COLLATE NOCASE"
        : "SELECT id FROM user WHERE id = ?1",
    )
    .bind(who)
    .first<{ id: string }>();
  if (!u) return null;
  const r = await db
    .prepare(
      `INSERT INTO stt_access (user_id, added_by, added_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(user_id) DO NOTHING`,
    )
    .bind(u.id, by, now)
    .run();
  if (changes(r) === 1)
    await audit(db, { kind: "stt-access.allow", actor: by, subject: u.id }, now);
  return u.id;
}

/** Take an account off the list. Its open sessions end at their next ticket (60 s at most). */
export async function disallowSttUser(
  db: SttDb,
  userId: string,
  by: string,
  now = Date.now(),
): Promise<boolean> {
  const r = await db.prepare("DELETE FROM stt_access WHERE user_id = ?1").bind(userId).run();
  const removed = changes(r) === 1;
  if (removed) await audit(db, { kind: "stt-access.disallow", actor: by, subject: userId }, now);
  return removed;
}

/* ---------------------------------------------------------------- workers */

/** A raw Ed25519 public key, base64url without padding (32 bytes = 43 characters). */
export const WORKER_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
/** A worker id: a short slug (shown in logs and on the page). */
export const WORKER_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export type SttWorkerRow = {
  id: string;
  pubkey: string;
  name: string;
  ownerUserId: string | null;
  capacity: number | null;
  createdBy: string;
  createdAt: number;
  revokedAt: number | null;
};

const WORKER_COLS = `id, pubkey, name, owner_user_id AS ownerUserId, capacity,
  created_by AS createdBy, created_at AS createdAt, revoked_at AS revokedAt`;

/** Every worker, newest first, revoked ones included (the admin page). */
export async function listSttWorkers(db: SttDb): Promise<SttWorkerRow[]> {
  const { results } = await db
    .prepare(`SELECT ${WORKER_COLS} FROM stt_worker ORDER BY created_at DESC`)
    .bind()
    .all<SttWorkerRow>();
  return results;
}

/**
 * The live worker with this public key, or null (unknown, revoked, or a failed
 * read): what the SttRegistry asks before it lets a worker register.
 */
export async function sttWorkerByKey(db: SttDb, pubkey: string): Promise<SttWorkerRow | null> {
  if (!WORKER_KEY_RE.test(pubkey)) return null;
  try {
    return await db
      .prepare(`SELECT ${WORKER_COLS} FROM stt_worker WHERE pubkey = ?1 AND revoked_at IS NULL`)
      .bind(pubkey)
      .first<SttWorkerRow>();
  } catch {
    return null;
  }
}

/**
 * Add a worker (the break-glass CLI, after the owner's approval). Refuses a bad
 * id or key, and an id or key already there.
 */
export async function addSttWorker(
  db: SttDb,
  w: {
    id: string;
    pubkey: string;
    name: string;
    ownerUserId?: string | null;
    capacity?: number | null;
  },
  by: string,
  now = Date.now(),
): Promise<boolean> {
  if (!WORKER_ID_RE.test(w.id) || !WORKER_KEY_RE.test(w.pubkey)) return false;
  const name = w.name.trim().slice(0, 80) || w.id;
  const cap = w.capacity ?? null;
  if (cap !== null && (!Number.isInteger(cap) || cap < 0)) return false;
  const r = await db
    .prepare(
      `INSERT INTO stt_worker (id, pubkey, name, owner_user_id, capacity, created_by, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT DO NOTHING`,
    )
    .bind(w.id, w.pubkey, name, w.ownerUserId ?? null, cap, by, now)
    .run();
  const added = changes(r) === 1;
  if (added) await audit(db, { kind: "stt-worker.add", actor: by, subject: w.id }, now);
  return added;
}

/** Revoke a worker: the registry refuses it from its next check on. */
/**
 * Mark a speech server as Lianki's own (official): it serves everyone on the
 * allowlist, not one account (owner, 2026-11-14: "TKUMAC 不要标记为某个账号自己的
 * 服务器，要标记为官方服务器"). Audited.
 */
export async function makeSttWorkerOfficial(
  db: SttDb,
  id: string,
  by: string,
  now = Date.now(),
): Promise<boolean> {
  const r = await db
    .prepare(
      "UPDATE stt_worker SET owner_user_id = NULL WHERE id = ?1 AND owner_user_id IS NOT NULL",
    )
    .bind(id)
    .run();
  const done = changes(r) === 1;
  if (done) await audit(db, { kind: "stt-worker.official", actor: by, subject: id }, now);
  return done;
}

export async function revokeSttWorker(
  db: SttDb,
  id: string,
  by: string,
  now = Date.now(),
): Promise<boolean> {
  const r = await db
    .prepare("UPDATE stt_worker SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL")
    .bind(id, now)
    .run();
  const revoked = changes(r) === 1;
  if (revoked) await audit(db, { kind: "stt-worker.revoke", actor: by, subject: id }, now);
  return revoked;
}
