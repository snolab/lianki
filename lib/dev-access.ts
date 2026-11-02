/**
 * Dev access tokens (docs/dev-whole-page.md, "Off the tailnet"): the key to the
 * owner's whole-page dev server on its public tunnel, preview.lianki.com.
 *
 * - Minted only by the owner's session on lianki.com (/dev/tokens, or a
 *   single-use handoff from the profile menu). The token is shown once; D1
 *   keeps its SHA-256 only (table dev_access_token, migration 0021).
 * - Verified only by the dev server's gate, which proves itself with
 *   DEV_BRIDGE_SECRET (POST /api/dev-access/verify). There is no public way to
 *   test a token.
 * - It signs in as the account that minted it, which must be an owner; the
 *   gate also insists it is the owner its login route mints.
 * - Revoking it (or "end all") ends it and every dev-server session made with
 *   it: the gate re-checks its sessions' token ids at most SESSION_RECHECK_MS
 *   apart.
 */

/** The subset of D1 used here (TestD1Database in tests). */
export interface DevAccessDb {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>;
      all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
      run(): Promise<unknown>;
    };
  };
}

export const TOKEN_PREFIX = "lkdev_";
export const HANDOFF_PREFIX = "lkhand_";
/** A handoff (profile menu → dev server) must be used this soon. */
export const HANDOFF_TTL_MS = 60_000;
/** A dev-server session lasts at most this long (and never past its token). */
export const SESSION_MAX_MS = 12 * 60 * 60 * 1000;
/** Token lifetimes the owner may pick. */
export const MIN_TOKEN_DAYS = 1;
export const MAX_TOKEN_DAYS = 90;
/** Live named tokens per owner, at most. */
export const MAX_LIVE_TOKENS = 20;

const DAY = 24 * 60 * 60 * 1000;

function rand(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function tokenHash(token: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A string that looks like one of ours (cheap check before any lookup). */
export function looksLikeToken(t: unknown): t is string {
  return typeof t === "string" && t.length <= 100 && /^(lkdev_|lkhand_)[A-Za-z0-9_-]{40,}$/.test(t);
}

export type Minter = { id: string; email: string };

export type TokenRow = {
  id: string;
  name: string;
  kind: "token" | "handoff";
  created_ms: number;
  expires_ms: number;
  consumed_ms: number | null;
  revoked_ms: number | null;
  last_used_ms: number | null;
};

export async function mintToken(
  db: DevAccessDb,
  who: Minter,
  name: string,
  days: number,
  now = Date.now(),
): Promise<{ id: string; token: string; expiresMs: number }> {
  const clean = name.trim().slice(0, 60);
  if (!clean) throw new DevAccessError(400, "a name is required");
  if (!Number.isInteger(days) || days < MIN_TOKEN_DAYS || days > MAX_TOKEN_DAYS)
    throw new DevAccessError(400, `days must be ${MIN_TOKEN_DAYS}–${MAX_TOKEN_DAYS}`);
  const live = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM dev_access_token WHERE user_id = ?1 AND kind = 'token' AND revoked_ms IS NULL AND expires_ms > ?2",
    )
    .bind(who.id, now)
    .first<{ n: number }>();
  if ((live?.n ?? 0) >= MAX_LIVE_TOKENS)
    throw new DevAccessError(409, `at most ${MAX_LIVE_TOKENS} live tokens: revoke one first`);
  return insert(db, who, "token", clean, now + days * DAY, now);
}

export async function mintHandoff(
  db: DevAccessDb,
  who: Minter,
  now = Date.now(),
): Promise<{ id: string; token: string; expiresMs: number }> {
  return insert(db, who, "handoff", "profile menu", now + HANDOFF_TTL_MS, now);
}

async function insert(
  db: DevAccessDb,
  who: Minter,
  kind: "token" | "handoff",
  name: string,
  expiresMs: number,
  now: number,
) {
  const id = rand(9);
  const token = `${kind === "token" ? TOKEN_PREFIX : HANDOFF_PREFIX}${rand(32)}`;
  await db
    .prepare(
      `INSERT INTO dev_access_token (id, user_id, email, kind, name, token_hash, created_ms, expires_ms)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(
      id,
      who.id,
      who.email.trim().toLowerCase(),
      kind,
      name,
      await tokenHash(token),
      now,
      expiresMs,
    )
    .run();
  return { id, token, expiresMs };
}

/** The owner's named tokens, newest first (never the hash). */
export async function listTokens(db: DevAccessDb, userId: string): Promise<TokenRow[]> {
  const r = await db
    .prepare(
      `SELECT id, name, kind, created_ms, expires_ms, consumed_ms, revoked_ms, last_used_ms
       FROM dev_access_token WHERE user_id = ?1 AND kind = 'token' ORDER BY created_ms DESC LIMIT 100`,
    )
    .bind(userId)
    .all<TokenRow>();
  return r.results;
}

/** Revoke one of the owner's tokens: true if it was live. */
export async function revokeToken(
  db: DevAccessDb,
  userId: string,
  id: string,
  now = Date.now(),
): Promise<boolean> {
  const row = await db
    .prepare(
      "UPDATE dev_access_token SET revoked_ms = ?3 WHERE user_id = ?1 AND id = ?2 AND revoked_ms IS NULL RETURNING id",
    )
    .bind(userId, id, now)
    .first<{ id: string }>();
  return Boolean(row);
}

/** Revoke every token and handoff of the owner: ends every dev-server session. */
export async function revokeAll(db: DevAccessDb, userId: string, now = Date.now()): Promise<void> {
  await db
    .prepare(
      "UPDATE dev_access_token SET revoked_ms = ?2 WHERE user_id = ?1 AND revoked_ms IS NULL",
    )
    .bind(userId, now)
    .run();
}

export type Verified = {
  id: string;
  email: string;
  kind: "token" | "handoff";
  /** The session made from it lasts until then. */
  sessionUntilMs: number;
};

/**
 * Check a token for the gate. A named token: live (not revoked, not expired).
 * A handoff: live and not used yet, and it is used up by this call (one
 * atomic UPDATE, so two racing requests cannot both pass). `owners`: the
 * minter must still be one of them.
 */
export async function verifyToken(
  db: DevAccessDb,
  token: unknown,
  owners: string[],
  now = Date.now(),
): Promise<Verified | null> {
  if (!looksLikeToken(token)) return null;
  const hash = await tokenHash(token);
  type R = { id: string; email: string; kind: "token" | "handoff"; expires_ms: number };
  let row: R | null;
  if (token.startsWith(HANDOFF_PREFIX)) {
    row = await db
      .prepare(
        `UPDATE dev_access_token SET consumed_ms = ?2, last_used_ms = ?2
         WHERE token_hash = ?1 AND kind = 'handoff' AND consumed_ms IS NULL AND revoked_ms IS NULL AND expires_ms > ?2
         RETURNING id, email, kind, expires_ms`,
      )
      .bind(hash, now)
      .first<R>();
  } else {
    row = await db
      .prepare(
        `UPDATE dev_access_token SET last_used_ms = ?2
         WHERE token_hash = ?1 AND kind = 'token' AND revoked_ms IS NULL AND expires_ms > ?2
         RETURNING id, email, kind, expires_ms`,
      )
      .bind(hash, now)
      .first<R>();
  }
  if (!row || !owners.includes(row.email)) return null;
  const cap = now + SESSION_MAX_MS;
  return {
    id: row.id,
    email: row.email,
    kind: row.kind,
    sessionUntilMs: row.kind === "token" ? Math.min(row.expires_ms, cap) : cap,
  };
}

/**
 * Which of these ids may still carry a session: not revoked, minted by an
 * owner, and (a named token) not expired, or (a handoff) used within the last
 * SESSION_MAX_MS.
 */
export async function activeIds(
  db: DevAccessDb,
  ids: string[],
  owners: string[],
  now = Date.now(),
): Promise<string[]> {
  const out: string[] = [];
  for (const id of [...new Set(ids)].slice(0, 50)) {
    const row = await db
      .prepare(
        "SELECT email, kind, expires_ms, consumed_ms, revoked_ms FROM dev_access_token WHERE id = ?1",
      )
      .bind(id)
      .first<{
        email: string;
        kind: string;
        expires_ms: number;
        consumed_ms: number | null;
        revoked_ms: number | null;
      }>();
    if (!row || row.revoked_ms !== null || !owners.includes(row.email)) continue;
    const live =
      row.kind === "token"
        ? row.expires_ms > now
        : row.consumed_ms !== null && row.consumed_ms + SESSION_MAX_MS > now;
    if (live) out.push(id);
  }
  return out;
}

export class DevAccessError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
