/**
 * OAuth sign-in for the remote MCP server, the D1 part (docs/mcp-oauth.md;
 * db/migrations/0084_mcp_oauth.sql). Secrets are stored only as SHA-256:
 * client secrets, codes, refresh tokens, and the access tokens (api_tokens).
 *
 * An access token is an `api_tokens` row with `oauth_grant_id` set: lk_ + 64
 * hex, the grant's scopes, a short expiry. checkToken (lib/api-tokens.ts)
 * refuses it once its grant is gone or the flag is off, so deleting a grant is
 * the whole revocation.
 */
import type { D1Like } from "@/lib/d1/types";
import { newSecret, rowScopes, type ScopeId } from "@/lib/api-tokens";
import { sha256Hex } from "@/lib/security/throttle";
import {
  AUTH_METHODS,
  CLIENT_ID_PREFIX,
  CLIENT_ID_RE,
  CLIENT_SECRET_PREFIX,
  CODE_RE,
  REFRESH_PREFIX,
  REFRESH_RE,
  randomHex,
  type AuthMethod,
  type AuthorizeRequest,
  type Client,
  type Registration,
} from "./rules";

const iso = (ms: number) => new Date(ms).toISOString();

export async function registerClient(
  db: D1Like,
  reg: Registration,
  now = Date.now(),
): Promise<{ clientId: string; secret: string | null; createdAt: number }> {
  const clientId = `${CLIENT_ID_PREFIX}${randomHex(16)}`;
  const secret = reg.authMethod === "none" ? null : `${CLIENT_SECRET_PREFIX}${randomHex(32)}`;
  await db
    .prepare(
      `INSERT INTO mcp_oauth_client (client_id, secret_hash, name, redirect_uris, auth_method, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      clientId,
      secret ? await sha256Hex(secret) : null,
      reg.name,
      JSON.stringify(reg.redirectUris),
      reg.authMethod,
      iso(now),
    )
    .run();
  return { clientId, secret, createdAt: now };
}

type ClientRow = {
  client_id: string;
  secret_hash: string | null;
  name: string;
  redirect_uris: string;
  auth_method: string;
};

export async function getClient(db: D1Like, clientId: unknown): Promise<Client | null> {
  if (typeof clientId !== "string" || !CLIENT_ID_RE.test(clientId)) return null;
  const r = await db
    .prepare("SELECT * FROM mcp_oauth_client WHERE client_id = ?")
    .bind(clientId)
    .first<ClientRow>();
  if (!r || !(AUTH_METHODS as readonly string[]).includes(r.auth_method)) return null;
  let uris: unknown;
  try {
    uris = JSON.parse(r.redirect_uris);
  } catch {
    return null;
  }
  if (!Array.isArray(uris)) return null;
  return {
    clientId: r.client_id,
    name: r.name,
    redirectUris: uris.filter((u): u is string => typeof u === "string"),
    authMethod: r.auth_method as AuthMethod,
    secretHash: r.secret_hash,
  };
}

/**
 * Does the request authenticate as `client` the way it registered? A public
 * client sends no secret; a confidential one sends its secret by its method.
 */
export async function clientAuthOk(
  client: Client,
  cred: { secret: string | null; method: AuthMethod },
): Promise<boolean> {
  if (client.authMethod === "none") return cred.method === "none" && cred.secret === null;
  if (cred.method !== client.authMethod || !cred.secret || !client.secretHash) return false;
  return (await sha256Hex(cred.secret)) === client.secretHash;
}

/** A one-time code for an approved request. The plain code is returned once. */
export async function createCode(
  db: D1Like,
  req: AuthorizeRequest,
  userId: string,
  scopes: ScopeId[],
  ttlMs: number,
  now = Date.now(),
): Promise<string> {
  const code = randomHex(32);
  // Expired codes are swept on the way; a code never outlives its minute anyway.
  await db.prepare("DELETE FROM mcp_oauth_code WHERE expires_at < ?").bind(iso(now)).run();
  await db
    .prepare(
      `INSERT INTO mcp_oauth_code (code_hash, client_id, user_id, redirect_uri, challenge, scopes, resource, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      await sha256Hex(code),
      req.clientId,
      userId,
      req.redirectUri,
      req.challenge,
      JSON.stringify(scopes),
      req.resource,
      iso(now + ttlMs),
    )
    .run();
  return code;
}

export type CodeRow = {
  client_id: string;
  user_id: string;
  redirect_uri: string;
  challenge: string;
  scopes: string;
  resource: string | null;
  expires_at: string;
};

/** Take a code: it is gone after this, whatever the exchange's outcome. */
export async function takeCode(db: D1Like, code: unknown): Promise<CodeRow | null> {
  if (typeof code !== "string" || !CODE_RE.test(code)) return null;
  return db
    .prepare("DELETE FROM mcp_oauth_code WHERE code_hash = ? RETURNING *")
    .bind(await sha256Hex(code))
    .first<CodeRow>();
}

/** The live account, or null when it is gone. */
export async function liveUser(
  db: D1Like,
  userId: string,
): Promise<{ id: string; email: string } | null> {
  return db.prepare("SELECT id, email FROM user WHERE id = ?").bind(userId).first();
}

export type Lifetimes = { accessMs: number; refreshMs: number };

export type Issued = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scopes: ScopeId[];
};

async function mintAccess(
  db: D1Like,
  grantId: string,
  user: { id: string; email: string },
  name: string,
  scopes: ScopeId[],
  accessMs: number,
  now: number,
): Promise<string> {
  const token = newSecret();
  await db
    .prepare(
      `INSERT INTO api_tokens (token_hash, email, name, created_at, user_id, scopes, expires_at, oauth_grant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      await sha256Hex(token),
      user.email,
      name,
      iso(now),
      user.id,
      JSON.stringify(scopes),
      iso(now + accessMs),
      grantId,
    )
    .run();
  return token;
}

/**
 * End a grant: the row first (its tokens are refused from then on), then its
 * tokens. Returns their ids (hashes), for the chat hub to close their sockets.
 */
async function dropGrant(db: D1Like, grantId: string): Promise<string[]> {
  await db.prepare("DELETE FROM mcp_oauth_grant WHERE id = ?").bind(grantId).run();
  const { results } = await db
    .prepare("DELETE FROM api_tokens WHERE oauth_grant_id = ? RETURNING token_hash")
    .bind(grantId)
    .all<{ token_hash: string }>();
  return results.map((r) => r.token_hash);
}

/**
 * The app connected (a code was exchanged): one grant per app and account, so
 * connecting again replaces the old grant and its tokens.
 */
export async function issueGrant(
  db: D1Like,
  client: Client,
  user: { id: string; email: string },
  scopes: ScopeId[],
  life: Lifetimes,
  now = Date.now(),
): Promise<Issued> {
  const old = await db
    .prepare("SELECT id FROM mcp_oauth_grant WHERE client_id = ? AND user_id = ?")
    .bind(client.clientId, user.id)
    .first<{ id: string }>();
  if (old) await dropGrant(db, old.id);
  const grantId = randomHex(16);
  const refreshToken = `${REFRESH_PREFIX}${randomHex(32)}`;
  await db
    .prepare(
      `INSERT INTO mcp_oauth_grant (id, client_id, user_id, scopes, refresh_hash, refresh_expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      grantId,
      client.clientId,
      user.id,
      JSON.stringify(scopes),
      await sha256Hex(refreshToken),
      iso(now + life.refreshMs),
      iso(now),
    )
    .run();
  const accessToken = await mintAccess(db, grantId, user, client.name, scopes, life.accessMs, now);
  return { accessToken, refreshToken, expiresIn: Math.floor(life.accessMs / 1000), scopes };
}

type GrantRow = {
  id: string;
  client_id: string;
  user_id: string;
  scopes: string;
  refresh_expires_at: string;
};

/**
 * Trade a refresh token for a new pair. The old refresh token works once: the
 * swap is one conditional UPDATE, so two racing refreshes cannot both win.
 * The grant's earlier access tokens are deleted.
 */
export async function refreshGrant(
  db: D1Like,
  client: Client,
  refreshToken: unknown,
  life: Lifetimes,
  now = Date.now(),
): Promise<Issued | null> {
  if (typeof refreshToken !== "string" || !REFRESH_RE.test(refreshToken)) return null;
  const oldHash = await sha256Hex(refreshToken);
  const g = await db
    .prepare("SELECT * FROM mcp_oauth_grant WHERE refresh_hash = ? AND client_id = ?")
    .bind(oldHash, client.clientId)
    .first<GrantRow>();
  if (!g) return null;
  if (!(Date.parse(g.refresh_expires_at) > now)) {
    await dropGrant(db, g.id);
    return null;
  }
  const user = await liveUser(db, g.user_id);
  if (!user) {
    await dropGrant(db, g.id);
    return null;
  }
  const next = `${REFRESH_PREFIX}${randomHex(32)}`;
  const swapped = await db
    .prepare(
      `UPDATE mcp_oauth_grant SET refresh_hash = ?, refresh_expires_at = ?, refreshed_at = ?
       WHERE id = ? AND refresh_hash = ? RETURNING id`,
    )
    .bind(await sha256Hex(next), iso(now + life.refreshMs), iso(now), g.id, oldHash)
    .first<{ id: string }>();
  if (!swapped) return null;
  await db.prepare("DELETE FROM api_tokens WHERE oauth_grant_id = ?").bind(g.id).run();
  const scopes = rowScopes(g.scopes);
  const accessToken = await mintAccess(db, g.id, user, client.name, scopes, life.accessMs, now);
  return {
    accessToken,
    refreshToken: next,
    expiresIn: Math.floor(life.accessMs / 1000),
    scopes,
  };
}

/**
 * RFC 7009: the app gives up a refresh or access token of its own. Either one
 * ends the whole grant. Another app's token, or an unknown one, changes nothing.
 */
export async function revokeByToken(db: D1Like, client: Client, token: unknown): Promise<string[]> {
  if (typeof token !== "string") return [];
  let grantId: string | null = null;
  if (REFRESH_RE.test(token)) {
    const g = await db
      .prepare("SELECT id FROM mcp_oauth_grant WHERE refresh_hash = ? AND client_id = ?")
      .bind(await sha256Hex(token), client.clientId)
      .first<{ id: string }>();
    grantId = g?.id ?? null;
  } else if (/^lk_[0-9a-f]{64}$/.test(token)) {
    const g = await db
      .prepare(
        `SELECT g.id FROM api_tokens t JOIN mcp_oauth_grant g ON g.id = t.oauth_grant_id
         WHERE t.token_hash = ? AND g.client_id = ?`,
      )
      .bind(await sha256Hex(token), client.clientId)
      .first<{ id: string }>();
    grantId = g?.id ?? null;
  }
  return grantId ? dropGrant(db, grantId) : [];
}

export type ConnectedApp = {
  id: string;
  name: string;
  /** Where the app's sign-in returns to: the host the consent page named. */
  host: string;
  scopes: ScopeId[];
  connectedAt: string;
  lastUsedAt: string | null;
};

/** The account's connected apps, newest first. */
export async function listGrants(db: D1Like, userId: string): Promise<ConnectedApp[]> {
  const { results } = await db
    .prepare(
      `SELECT g.id, g.scopes, g.created_at, g.refreshed_at, c.name, c.redirect_uris,
              (SELECT MAX(t.last_used_at) FROM api_tokens t WHERE t.oauth_grant_id = g.id) AS used
       FROM mcp_oauth_grant g JOIN mcp_oauth_client c ON c.client_id = g.client_id
       WHERE g.user_id = ? ORDER BY g.created_at DESC`,
    )
    .bind(userId)
    .all<{
      id: string;
      scopes: string;
      created_at: string;
      refreshed_at: string | null;
      name: string;
      redirect_uris: string;
      used: string | null;
    }>();
  return results.map((r) => {
    let host = "";
    try {
      host = new URL(JSON.parse(r.redirect_uris)[0]).host;
    } catch {
      /* an unreadable row shows no host */
    }
    const used = [r.used, r.refreshed_at].filter((x): x is string => !!x).sort();
    return {
      id: r.id,
      name: r.name,
      host,
      scopes: rowScopes(r.scopes),
      connectedAt: r.created_at,
      lastUsedAt: used.at(-1) ?? null,
    };
  });
}

/**
 * Disconnect one of the account's apps; another account's grant is "not
 * found" (null). The ids of the tokens that ended.
 */
export async function revokeGrant(
  db: D1Like,
  userId: string,
  id: unknown,
): Promise<string[] | null> {
  if (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id)) return null;
  const g = await db
    .prepare("SELECT id FROM mcp_oauth_grant WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first<{ id: string }>();
  if (!g) return null;
  return dropGrant(db, g.id);
}
