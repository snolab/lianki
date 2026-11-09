/**
 * The binding between a box and the one account it may sign in as
 * (db/migrations/0046_box_oauth.sql, docs/box-oauth.md). The plugin's own
 * tables hold the client and its tokens; this holds what the plugin has no idea
 * of: which account, and which origin. Both are unique while the binding is
 * live, so one account has one box and one box has one account.
 */
import { holdsSql, userHolds } from "@/lib/account-permission";
import { audit, type AuditDb } from "@/lib/security/audit-log";
import { SCOPE_CHAT, SCOPE_EVAL, isBoxOrigin, parseScopes } from "./rules";

export interface BoxStmt {
  bind(...v: unknown[]): BoxStmt;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface BoxDb {
  prepare(sql: string): BoxStmt;
  batch?(stmts: BoxStmt[]): Promise<unknown>;
}

export type Binding = {
  clientId: string;
  origin: string;
  userId: string;
  scopes: string[];
  createdAt: number;
  revokedAt: number | null;
};

type Row = {
  client_id: string;
  origin: string;
  user_id: string;
  scopes: string;
  created_at: number;
  revoked_at: number | null;
};

const toBinding = (r: Row): Binding => ({
  clientId: r.client_id,
  origin: r.origin,
  userId: r.user_id,
  scopes: parseScopes(r.scopes),
  createdAt: r.created_at,
  revokedAt: r.revoked_at,
});

const COLS = "client_id, origin, user_id, scopes, created_at, revoked_at";

/**
 * The box allowlist (docs/box-oauth.md, "Who may have a box"): my-box is a
 * premium feature, default deny. A user may have a box, and a box may do
 * anything at all, only while that user is on the owner's list — the same list
 * as custom frontends (`live_frontend_allow`, /dev/box-clients and
 * /dev/live-frontends) — or holds the `dev` permission (lib/permissions.ts).
 * As SQL, so every lookup a box's use goes through reads it in the same query,
 * live.
 */
const allowedUser = (col: string) =>
  `(EXISTS (SELECT 1 FROM live_frontend_allow la WHERE la.user_id = ${col})
    OR ${holdsSql(col, "dev")})`;

/** May this account have a box (bind time)? */
export async function isBoxAllowed(db: BoxDb, userId: string): Promise<boolean> {
  const r = await db
    .prepare(`SELECT 1 AS ok FROM user u WHERE u.id = ?1 AND ${allowedUser("u.id")}`)
    .bind(userId)
    .first<{ ok: number }>();
  return r?.ok === 1;
}

async function liveBinding(
  db: BoxDb,
  where: "client_id" | "origin" | "user_id",
  value: string,
  allowedOnly: boolean,
): Promise<Binding | null> {
  const r = await db
    .prepare(
      `SELECT ${COLS} FROM box_binding b WHERE b.${where} = ?1 AND b.revoked_at IS NULL${
        allowedOnly ? ` AND ${allowedUser("b.user_id")}` : ""
      }`,
    )
    .bind(value)
    .first<Row>();
  return r ? toBinding(r) : null;
}

/** The live binding of a client whose account is on the box allowlist, or null. */
export const bindingByClient = (db: BoxDb, clientId: string) =>
  liveBinding(db, "client_id", clientId, true);

/** The live binding of an origin whose account is on the box allowlist, or null. */
export const bindingByOrigin = (db: BoxDb, origin: string) =>
  liveBinding(db, "origin", origin, true);

/** The owner's view: a live binding whatever the allowlist says, so it can still be revoked. */
const anyBindingByClient = (db: BoxDb, clientId: string) =>
  liveBinding(db, "client_id", clientId, false);
export const anyBindingByUser = (db: BoxDb, userId: string) =>
  liveBinding(db, "user_id", userId, false);

export async function listBindings(
  db: BoxDb,
): Promise<(Binding & { email: string | null; allowed: boolean })[]> {
  const { results } = await db
    .prepare(
      `SELECT b.client_id, b.origin, b.user_id, b.scopes, b.created_at, b.revoked_at, u.email AS email,
              ${allowedUser("b.user_id")} AS allowed
       FROM box_binding b LEFT JOIN user u ON u.id = b.user_id
       ORDER BY b.revoked_at IS NOT NULL, b.created_at DESC LIMIT 200`,
    )
    .all<Row & { email: string | null; allowed: number }>();
  return results.map((r) => ({ ...toBinding(r), email: r.email, allowed: r.allowed === 1 }));
}

export type NewBinding = { clientId: string; origin: string; userId: string; scopes: string[] };

/** False when the origin or the account already has a live box (the partial unique indexes). */
export async function insertBinding(
  db: BoxDb,
  b: NewBinding,
  by: string,
  now = Date.now(),
): Promise<boolean> {
  try {
    await db
      .prepare(
        `INSERT INTO box_binding (client_id, origin, user_id, scopes, created_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind(b.clientId, b.origin, b.userId, b.scopes.join(" "), by, now)
      .run();
  } catch {
    return false;
  }
  await audit(
    db as unknown as AuditDb,
    { kind: "box.bind", actor: by, subject: b.userId, detail: b.clientId },
    now,
  );
  return true;
}

/**
 * The one owner action: the box can sign in no more, and every token it holds
 * stops at once. The gate reads the binding on each request, so even a token
 * row this somehow missed is refused.
 */
export async function revokeBox(
  db: BoxDb,
  clientId: string,
  by: string,
  now = Date.now(),
): Promise<boolean> {
  const live = await anyBindingByClient(db, clientId);
  if (!live) return false;
  const iso = new Date(now).toISOString();
  const stmts = [
    db.prepare("UPDATE box_binding SET revoked_at = ?1 WHERE client_id = ?2").bind(now, clientId),
    db.prepare("UPDATE oauthClient SET disabled = 1 WHERE clientId = ?1").bind(clientId),
    db
      .prepare("UPDATE oauthAccessToken SET revoked = ?1 WHERE clientId = ?2 AND revoked IS NULL")
      .bind(iso, clientId),
    db
      .prepare("UPDATE oauthRefreshToken SET revoked = ?1 WHERE clientId = ?2 AND revoked IS NULL")
      .bind(iso, clientId),
  ];
  if (db.batch) await db.batch(stmts);
  else for (const s of stmts) await s.run();
  await audit(
    db as unknown as AuditDb,
    { kind: "box.revoke", actor: by, subject: live.userId, detail: clientId },
    now,
  );
  return true;
}

export type TokenRow = {
  clientId: string;
  userId: string;
  scopes: string[];
  origin: string;
};

/** A live token joined to its live binding: the same account, on the box allowlist, or no answer at all. */
export async function liveToken(
  db: BoxDb,
  tokenHash: string,
  now = Date.now(),
): Promise<TokenRow | null> {
  const r = await db
    .prepare(
      `SELECT t.clientId AS clientId, t.userId AS userId, t.scopes AS scopes, t.expiresAt AS expiresAt,
              b.origin AS origin, b.scopes AS boundScopes
       FROM oauthAccessToken t
       JOIN box_binding b ON b.client_id = t.clientId AND b.user_id = t.userId
       JOIN oauthClient c ON c.clientId = t.clientId
       WHERE t.token = ?1 AND t.revoked IS NULL AND b.revoked_at IS NULL
         AND (c.disabled IS NULL OR c.disabled = 0)
         AND ${allowedUser("b.user_id")}`,
    )
    .bind(tokenHash)
    .first<{
      clientId: string;
      userId: string;
      scopes: unknown;
      expiresAt: string;
      origin: string;
      boundScopes: string;
    }>();
  if (!r || !(Date.parse(r.expiresAt) > now)) return null;
  // Never more than the owner granted, whatever the token row says.
  const bound = parseScopes(r.boundScopes);
  // box:eval never rides on a token: it opens no route, and the hub asks the binding itself.
  const scopes = parseScopes(r.scopes).filter(
    (s) => bound.includes(s) && s !== SCOPE_CHAT && s !== SCOPE_EVAL,
  );
  // box:chat is the binding's alone (rules.ts): it lasts exactly as long as the grant.
  if (bound.includes(SCOPE_CHAT)) scopes.push(SCOPE_CHAT);
  return { clientId: r.clientId, userId: r.userId, origin: r.origin, scopes };
}

/**
 * Does this account hold the `dev` permission right now (account_permission,
 * lib/permissions.ts)? Read from D1 each time, never from a cache: box:chat is
 * refused the moment the grant is revoked. Exact address, as the snapshot
 * compares them.
 */
export const isDevUser = (db: BoxDb, userId: string): Promise<boolean> =>
  userHolds(db, userId, "dev");

export type ChatGrant = "granted" | "removed" | "unchanged" | "no-box" | "not-owner";

/**
 * The owner grants or removes box:chat on a live binding. Granting is refused
 * unless the binding's account is a site owner. Removing needs no check. Each
 * change is in security_audit.
 */
export async function setBoxChat(
  db: BoxDb,
  clientId: string,
  on: boolean,
  by: string,
  now = Date.now(),
): Promise<ChatGrant> {
  const live = await anyBindingByClient(db, clientId);
  if (!live) return "no-box";
  const has = live.scopes.includes(SCOPE_CHAT);
  if (on && !(await isDevUser(db, live.userId))) return "not-owner";
  if (has === on) return "unchanged";
  // box:eval rides on the chat socket: removing chat removes it too.
  const hadEval = live.scopes.includes(SCOPE_EVAL);
  const scopes = on
    ? [...live.scopes, SCOPE_CHAT]
    : live.scopes.filter((s) => s !== SCOPE_CHAT && s !== SCOPE_EVAL);
  await db
    .prepare("UPDATE box_binding SET scopes = ?1 WHERE client_id = ?2 AND revoked_at IS NULL")
    .bind(scopes.join(" "), clientId)
    .run();
  if (!on && hadEval)
    await audit(
      db as unknown as AuditDb,
      { kind: "box.eval-remove", actor: by, subject: live.userId, detail: clientId },
      now,
    );
  await audit(
    db as unknown as AuditDb,
    {
      kind: on ? "box.chat-grant" : "box.chat-remove",
      actor: by,
      subject: live.userId,
      detail: clientId,
    },
    now,
  );
  return on ? "granted" : "removed";
}

export type EvalGrant = ChatGrant | "needs-chat";

/**
 * The owner grants or removes box:eval (docs/box-oauth.md, "Code on the
 * owner's box") on a live binding. Granting is refused unless the binding's
 * account is a site owner and the binding holds box:chat already (eval rides
 * on the chat socket); it is never implied by box:chat. Removing needs no
 * check. Each change is in security_audit.
 */
export async function setBoxEval(
  db: BoxDb,
  clientId: string,
  on: boolean,
  by: string,
  now = Date.now(),
): Promise<EvalGrant> {
  const live = await anyBindingByClient(db, clientId);
  if (!live) return "no-box";
  const has = live.scopes.includes(SCOPE_EVAL);
  if (on && !(await isDevUser(db, live.userId))) return "not-owner";
  if (on && !live.scopes.includes(SCOPE_CHAT)) return "needs-chat";
  if (has === on) return "unchanged";
  const scopes = on ? [...live.scopes, SCOPE_EVAL] : live.scopes.filter((s) => s !== SCOPE_EVAL);
  await db
    .prepare("UPDATE box_binding SET scopes = ?1 WHERE client_id = ?2 AND revoked_at IS NULL")
    .bind(scopes.join(" "), clientId)
    .run();
  await audit(
    db as unknown as AuditDb,
    {
      kind: on ? "box.eval-grant" : "box.eval-remove",
      actor: by,
      subject: live.userId,
      detail: clientId,
    },
    now,
  );
  return on ? "granted" : "removed";
}

/**
 * May a box's page hold the owner's page powers (eval, pairing, page errors)?
 * The hub asks at connect and before each use. The client's binding is live
 * with box:chat and box:eval, and its account a site owner now. The flag is
 * the caller's to check.
 */
export async function boxEvalLive(db: BoxDb, clientId: unknown): Promise<boolean> {
  if (typeof clientId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(clientId)) return false;
  const b = await bindingByClient(db, clientId);
  return (
    !!b &&
    b.scopes.includes(SCOPE_CHAT) &&
    b.scopes.includes(SCOPE_EVAL) &&
    (await isDevUser(db, b.userId))
  );
}

/**
 * May the hub keep a box's chat socket (lianki-push asks before each line it
 * takes from one)? The client's binding is live with box:chat and its account a
 * site owner. The flag is the caller's to check.
 */
export async function boxChatLive(db: BoxDb, clientId: unknown): Promise<boolean> {
  if (typeof clientId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(clientId)) return false;
  const b = await bindingByClient(db, clientId);
  return !!b && b.scopes.includes(SCOPE_CHAT) && (await isDevUser(db, b.userId));
}

/**
 * The binding a box:chat request may act for, checked at use: the live binding
 * of that client, for that account, holding box:chat, whose account is a site
 * owner now. Anything else is null.
 */
export async function chatBinding(
  db: BoxDb,
  clientId: string,
  userId: string,
): Promise<Binding | null> {
  const b = await bindingByClient(db, clientId);
  if (!b || b.userId !== userId || !b.scopes.includes(SCOPE_CHAT)) return null;
  return (await isDevUser(db, userId)) ? b : null;
}

/** The user row the app sees for a verified identity. */
export type BoxUserRow = {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  emailVerified: number | boolean | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export async function boxUser(db: BoxDb, userId: string): Promise<BoxUserRow | null> {
  return db
    .prepare(
      "SELECT id, email, name, image, emailVerified, createdAt, updatedAt FROM user WHERE id = ?1",
    )
    .bind(userId)
    .first<BoxUserRow>();
}

export function validNewBox(origin: unknown, scopes: unknown, dev: boolean): string | null {
  if (typeof origin !== "string" || !isBoxOrigin(origin, dev))
    return "origin must be exactly https://my-<hash>.lianki.com or https://my-<name>.lianki.com (name: 3-30 of a-z, 0-9, inner hyphens; not reserved)";
  if (!Array.isArray(scopes) || scopes.length === 0) return "scopes required";
  if (!scopes.every((s) => s === "box:read" || s === "box:write"))
    return "scopes: box:read and/or box:write";
  return null;
}
