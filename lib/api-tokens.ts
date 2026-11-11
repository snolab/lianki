/**
 * Fine-grained API tokens (`lk_…`), modelled on GitHub's fine-grained personal
 * access tokens (docs/secrets-and-auth.md, "API tokens"). One system for every
 * token: the userscript's, `lianki auth login`'s, and the agent lanes'.
 *
 * - **One account.** A token belongs to the account that made it: `user_id`
 *   (and the email) are fixed at creation and checked on every use, joined to
 *   the live `user` row. A token can never act for another account, and dies
 *   with its account (no row, no match) or a sign-out everywhere (all of the
 *   account's tokens are deleted, auth-impl.ts).
 * - **Explicit permissions**, chosen at creation from SCOPES (data, below).
 *   Nothing else is selectable: pairing, grants and admin are not
 *   permissions a token can hold (FORBIDDEN_SCOPES), so no route can ask for
 *   them. A route asks for one scope; a token without it is refused.
 * - **`eval`, the site owner's alone** (OWNER_SCOPES; docs/secrets-and-auth.md,
 *   "Eval tokens"): run code on the owner's open pages with no pairing tap.
 *   Offered and accepted only for a session holding `dev`, at most
 *   EVAL_MAX_DAYS, and checked again at every use (lib/eval-token.ts).
 * - **Required expiry**, picked by the user: EXPIRY_DAYS or a date, at most
 *   MAX_EXPIRY_DAYS ahead. No silent "forever".
 * - **Last used**, written at most once a minute (LAST_USED_EVERY_MS).
 * - The secret is shown once; only its SHA-256 is stored. The token's public
 *   id is that hash (`id`); hub sockets and the audit log carry its first 16
 *   characters (`tag`). Neither is ever the token.
 *
 * Rows from before scopes (0056_api_token_scopes.sql): `scopes` NULL reads as
 * LEGACY_SCOPES (cards and settings, never chat), `expires_at` NULL as no
 * expiry, `user_id` NULL as "the account with this email".
 */
import type { D1Like } from "@/lib/d1/types";
import { sha256Hex } from "@/lib/security/throttle";

export const TOKEN_RE = /^lk_[0-9a-f]{64}$/;

/**
 * Every permission a token can be given, in the order the token page lists
 * them. `group` is the page's heading. Adding one here is the only way a new
 * permission exists; a route then asks for it by id.
 */
export const SCOPES = [
  // Cards, reviews, word lists, settings, the study plan: everything a token
  // could do before scopes (the userscript, `lianki next/review/settings`).
  { id: "study", group: "study" },
  // The chat (`lianki chat`): only the account's own thread, the Learning
  // Partner's (for the owner, the owner's thread).
  { id: "chat:read", group: "chat" }, // read lines, listen
  { id: "chat:write", group: "chat" }, // post a line
  { id: "chat:ask", group: "chat" }, // post an ask card (only a tap answers it)
  { id: "chat:play", group: "chat" }, // post a line with audio his phone plays (`say --play`)
  // Run code on the owner's open pages (eval.ts, lianki-dev), no pairing tap:
  // a site owner's token only (OWNER_SCOPES), at most EVAL_MAX_DAYS.
  { id: "eval", group: "owner" },
] as const;

export type ScopeId = (typeof SCOPES)[number]["id"];
export const SCOPE_IDS: readonly ScopeId[] = SCOPES.map((s) => s.id);

/** Never a permission, whatever is sent: a request naming one is refused outright. */
export const FORBIDDEN_SCOPES = ["pair", "grant", "admin", "answer", "owner"] as const;

/**
 * Permissions only an account holding `dev` may give a token (account_permission, read live at
 * creation and at every use). Anyone else is never offered them, and a
 * request naming one is refused as if it did not exist.
 */
export const OWNER_SCOPES: readonly ScopeId[] = ["eval"];
/** An eval token lives at most this long (owner's decision, 2026-11-07). */
export const EVAL_MAX_DAYS = 30;

/** What a row from before scopes may do. */
export const LEGACY_SCOPES: readonly ScopeId[] = ["study"];

/** Expiry choices on the token page, in days; the page also takes a date. */
export const EXPIRY_DAYS = [7, 30, 90, 365] as const;
export const MAX_EXPIRY_DAYS = 366;
/** The earliest a token may expire: an hour from now. */
export const MIN_EXPIRY_MS = 60 * 60_000;
const DAY = 86_400_000;

/** How often `last_used_at` is written for one token. */
export const LAST_USED_EVERY_MS = 60_000;

/** The longest token name (it is the lane's name in the chat). */
export const MAX_NAME = 40;

/** The public id's short form, for sockets and the audit log. */
export const tagOf = (id: string) => id.slice(0, 16);

/** A token's name: trimmed, one line, no control characters, no 【】, 1–MAX_NAME long. */
export function cleanTokenName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\u3010\u3011]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return s && [...s].length <= MAX_NAME ? s : null;
}

/**
 * The scope list as sent: known ids only, at least one, no forbidden one; else
 * null. OWNER_SCOPES count only with `owner` (the caller has checked that the
 * session is a site owner's); otherwise they are unknown.
 */
export function parseScopes(raw: unknown, opts: { owner?: boolean } = {}): ScopeId[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > SCOPES.length * 2) return null;
  const out = new Set<ScopeId>();
  for (const s of raw) {
    if (typeof s !== "string") return null;
    if (!(SCOPE_IDS as readonly string[]).includes(s)) return null;
    if (!opts.owner && (OWNER_SCOPES as readonly string[]).includes(s)) return null;
    out.add(s as ScopeId);
  }
  return SCOPE_IDS.filter((s) => out.has(s));
}

/** A stored row's scopes (NULL = legacy); anything unreadable = none. */
export function rowScopes(raw: string | null | undefined): ScopeId[] {
  if (raw === null || raw === undefined) return [...LEGACY_SCOPES];
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? SCOPE_IDS.filter((s) => p.includes(s)) : [];
  } catch {
    return [];
  }
}

/**
 * The expiry as sent: `{days}` from EXPIRY_DAYS, or `{date}` (an ISO date or
 * time) between MIN_EXPIRY_MS and MAX_EXPIRY_DAYS from now. A bare date means
 * the end of that day in UTC. Anything else, or none, is null: there is no
 * default.
 */
export function parseExpiry(raw: unknown, now = Date.now()): Date | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { days?: unknown; date?: unknown };
  let at: number;
  if (r.days !== undefined) {
    if (!(EXPIRY_DAYS as readonly unknown[]).includes(r.days)) return null;
    at = now + (r.days as number) * DAY;
  } else if (typeof r.date === "string" && r.date.length <= 40) {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? `${r.date}T23:59:59.999Z` : r.date;
    at = Date.parse(d);
    if (!Number.isFinite(at)) return null;
  } else return null;
  if (at < now + MIN_EXPIRY_MS || at > now + MAX_EXPIRY_DAYS * DAY) return null;
  return new Date(at);
}

/** A new token's secret: lk_ + 64 hex. */
export function newSecret(): string {
  const hex = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `lk_${hex}`;
}

export type TokenOwner = { userId: string; email: string };

export type TokenInfo = {
  /** The token's SHA-256: its public id. */
  id: string;
  name: string;
  /** The account it acts as. */
  email: string;
  scopes: ScopeId[];
  createdAt: string;
  /** null only on rows from before scopes. */
  expiresAt: string | null;
  lastUsedAt: string | null;
  expired: boolean;
};

type Row = {
  token_hash: string;
  email: string;
  name: string;
  created_at: string;
  user_id: string | null;
  scopes: string | null;
  expires_at: string | null;
  last_used_at: string | null;
};

const isExpired = (expiresAt: string | null, now: number) =>
  expiresAt !== null && !(Date.parse(expiresAt) > now);

const info = (r: Row, now: number): TokenInfo => ({
  id: r.token_hash,
  name: r.name,
  email: r.email,
  scopes: rowScopes(r.scopes),
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  lastUsedAt: r.last_used_at,
  expired: isExpired(r.expires_at, now),
});

/** The rows that are this account's: bound to its id, or (rows from before) its email. */
const MINE = "(user_id = ?1 OR (user_id IS NULL AND email = ?2))";

/** Mint a token for `owner`. The secret is returned once and never stored. */
export async function createToken(
  db: D1Like,
  owner: TokenOwner,
  t: { name: string; scopes: ScopeId[]; expiresAt: Date },
  now = Date.now(),
): Promise<{ token: string; id: string }> {
  const token = newSecret();
  const id = await sha256Hex(token);
  await db
    .prepare(
      `INSERT INTO api_tokens (token_hash, email, name, created_at, user_id, scopes, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      owner.email,
      t.name,
      new Date(now).toISOString(),
      owner.userId,
      JSON.stringify(t.scopes),
      t.expiresAt.toISOString(),
    )
    .run();
  return { token, id };
}

/** This account's tokens, newest first. */
export async function listTokens(db: D1Like, owner: TokenOwner, now = Date.now()) {
  const { results } = await db
    .prepare(`SELECT * FROM api_tokens WHERE ${MINE} ORDER BY created_at DESC`)
    .bind(owner.userId, owner.email)
    .all<Row>();
  return results.map((r) => info(r, now));
}

/** Revoke one of this account's tokens by id; another account's is "not found". */
export async function revokeToken(
  db: D1Like,
  owner: TokenOwner,
  id: unknown,
): Promise<TokenInfo | null> {
  if (typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id)) return null;
  const r = await db
    .prepare(`DELETE FROM api_tokens WHERE token_hash = ?3 AND ${MINE} RETURNING *`)
    .bind(owner.userId, owner.email, id)
    .first<Row>();
  return r ? info(r, Date.now()) : null;
}

/** Every token of the account (a sign-out everywhere, the account deleted). Their ids. */
export async function revokeAllTokens(db: D1Like, owner: TokenOwner): Promise<string[]> {
  const { results } = await db
    .prepare(`DELETE FROM api_tokens WHERE ${MINE} RETURNING token_hash`)
    .bind(owner.userId, owner.email)
    .all<{ token_hash: string }>();
  return results.map((r) => r.token_hash);
}

/**
 * What a live token may do, asked by the token itself (GET /api/cli-login/token,
 * `lianki mcp` listing only the tools it allows). Null for an unknown or
 * expired token, or one whose account is gone. Read-only: no last_used write.
 */
export async function describeToken(
  db: D1Like,
  token: unknown,
  now = Date.now(),
): Promise<{ name: string; scopes: ScopeId[]; expiresAt: string | null } | null> {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
  const r = await db
    .prepare(
      `SELECT t.name, t.scopes, t.expires_at FROM api_tokens t JOIN user u ON u.email = t.email
         AND (t.user_id IS NULL OR u.id = t.user_id)
       WHERE t.token_hash = ?`,
    )
    .bind(await sha256Hex(token))
    .first<Pick<Row, "name" | "scopes" | "expires_at">>();
  if (!r || isExpired(r.expires_at, now)) return null;
  return { name: r.name, scopes: rowScopes(r.scopes), expiresAt: r.expires_at };
}

export type TokenUser = { id: string; email: string; name: string | null; image: string | null };

export type CheckResult =
  | {
      ok: true;
      user: TokenUser;
      id: string;
      name: string;
      scopes: ScopeId[];
      expiresAt: string | null;
      /** last_used_at was written by this check (the audit logs a use then). */
      touched: boolean;
    }
  | {
      ok: false;
      reason: "malformed" | "unknown" | "expired" | "scope";
      id?: string;
      userId?: string;
    };

/**
 * Is `token` (the secret, or its hash with `byHash`) a live token of a live
 * account, holding `need`? Its account is the `user` row with the token's
 * bound id and email (rows from before: the email); no row, no account.
 */
export async function checkToken(
  db: D1Like,
  token: unknown,
  need: ScopeId,
  now = Date.now(),
  opts: { byHash?: boolean } = {},
): Promise<CheckResult> {
  let id: string;
  if (opts.byHash) {
    if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token))
      return { ok: false, reason: "malformed" };
    id = token;
  } else {
    if (typeof token !== "string" || !TOKEN_RE.test(token))
      return { ok: false, reason: "malformed" };
    id = await sha256Hex(token);
  }
  const r = await db
    .prepare(
      `SELECT t.token_hash, t.name, t.scopes, t.expires_at, t.last_used_at,
              u.id AS uid, u.email AS uemail, u.name AS uname, u.image AS uimage
       FROM api_tokens t JOIN user u ON u.email = t.email
         AND (t.user_id IS NULL OR u.id = t.user_id)
       WHERE t.token_hash = ?`,
    )
    .bind(id)
    .first<
      Pick<Row, "token_hash" | "name" | "scopes" | "expires_at" | "last_used_at"> & {
        uid: string;
        uemail: string;
        uname: string | null;
        uimage: string | null;
      }
    >();
  if (!r) return { ok: false, reason: "unknown" };
  if (isExpired(r.expires_at, now)) return { ok: false, reason: "expired", id, userId: r.uid };
  const scopes = rowScopes(r.scopes);
  if (!scopes.includes(need)) return { ok: false, reason: "scope", id, userId: r.uid };
  let touched = false;
  const last = r.last_used_at ? Date.parse(r.last_used_at) : NaN;
  if (!(now - last < LAST_USED_EVERY_MS)) {
    await db
      .prepare("UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?")
      .bind(new Date(now).toISOString(), id)
      .run();
    touched = true;
  }
  return {
    ok: true,
    user: { id: r.uid, email: r.uemail, name: r.uname, image: r.uimage },
    id,
    name: r.name,
    scopes,
    expiresAt: r.expires_at,
    touched,
  };
}
