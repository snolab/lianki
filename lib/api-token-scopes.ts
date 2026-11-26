/** Session-owned, additive scope approval. Public token ids are never credentials. */
import {
  type ScopeId,
  type TokenOwner,
  rowScopes,
  tagOf,
  OWNER_SCOPES,
  EVAL_MAX_DAYS,
  MINT_CHILD,
  parseScopes,
} from "./api-tokens";
import type { TokenApiDeps } from "./api-token-api";
import type { D1Like } from "./d1/types";
import { sameOriginJson, sameOriginJsonPost } from "./security/same-origin";
import { audit } from "./security/audit-log";

type Row = {
  token_hash: string;
  name: string;
  scopes: string | null;
  expires_at: string | null;
  parent_hash?: string | null;
};
const ID = /^[0-9a-f]{64}$/;
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
const tokenView = (row: Row) => ({
  id: row.token_hash,
  name: row.name,
  scopes: rowScopes(row.scopes),
  expiresAt: row.expires_at,
});
const scopeOf = (raw: unknown): ScopeId | null => parseScopes([raw], { owner: true })?.[0] ?? null;
// Not an OAuth app's token (docs/mcp-oauth.md): its permissions are the grant's,
// changed only by connecting the app again, never by a scope request.
const LIVE = `(user_id = ?1 OR (user_id IS NULL AND email = ?2)) AND oauth_grant_id IS NULL
  AND EXISTS (SELECT 1 FROM user u WHERE u.id = ?1 AND u.email = api_tokens.email
    AND (api_tokens.user_id IS NULL OR api_tokens.user_id = u.id))
  AND (expires_at IS NULL OR julianday(expires_at) > julianday(?4))`;

/** Read metadata only when both the token and its account are still live and owned by this session. */
export async function ownLiveToken(
  db: D1Like,
  owner: TokenOwner,
  id: unknown,
  now: number,
): Promise<Row | null> {
  if (typeof id !== "string" || !ID.test(id)) return null;
  return db
    .prepare(
      `SELECT token_hash, name, scopes, expires_at, parent_hash FROM api_tokens WHERE token_hash = ?3 AND ${LIVE}`,
    )
    .bind(owner.userId, owner.email, id, new Date(now).toISOString())
    .first<Row>();
}

function expiryCapped(scope: ScopeId) {
  return scope === "eval" || scope === "recordings:read";
}

/** Every approval is a single atomic union, so concurrent grants and revocation cannot be overwritten. */
export async function appendTokenScope(
  db: D1Like,
  owner: TokenOwner,
  id: string,
  scope: ScopeId,
  now: number,
): Promise<Row | null> {
  const scopes = `CASE WHEN scopes IS NULL THEN '["study"]' WHEN json_valid(scopes) THEN CASE WHEN json_type(scopes) = 'array' THEN scopes ELSE '[]' END ELSE '[]' END`;
  return db
    .prepare(`UPDATE api_tokens SET scopes = CASE
      WHEN EXISTS (SELECT 1 FROM json_each(${scopes}) WHERE value = ?5) THEN ${scopes}
      ELSE json_insert(${scopes}, '$[#]', ?5) END
    WHERE token_hash = ?3 AND ${LIVE}
      AND (?7 = 0 OR EXISTS (
        SELECT 1 FROM account_permission p JOIN user u ON p.email = lower(trim(u.email))
        WHERE u.id = ?1 AND p.permission = 'dev' AND p.revoked_at IS NULL))
      AND (?8 = 0 OR (expires_at IS NOT NULL AND julianday(expires_at) <= julianday(?6)))
      AND (?5 != 'token:mint-child' OR (parent_hash IS NULL AND expires_at IS NOT NULL))
    RETURNING token_hash, name, scopes, expires_at`)
    .bind(
      owner.userId,
      owner.email,
      id,
      new Date(now).toISOString(),
      scope,
      new Date(now + EVAL_MAX_DAYS * 86_400_000).toISOString(),
      OWNER_SCOPES.includes(scope) ? 1 : 0,
      expiryCapped(scope) ? 1 : 0,
    )
    .first<Row>();
}

/**
 * Take `token:mint-child` off one of this account's tokens (the switch on its
 * row). Its children stop at once (checkToken needs the parent to hold it).
 */
export async function removeMintChild(
  db: D1Like,
  owner: TokenOwner,
  id: string,
  now: number,
): Promise<Row | null> {
  return db
    .prepare(`UPDATE api_tokens SET scopes = (
        SELECT json_group_array(value) FROM json_each(scopes) WHERE value != ?5)
      WHERE token_hash = ?3 AND ${LIVE} AND json_valid(scopes)
    RETURNING token_hash, name, scopes, expires_at`)
    .bind(owner.userId, owner.email, id, new Date(now).toISOString(), MINT_CHILD)
    .first<Row>();
}

/**
 * GET is read-only; POST requires one explicit same-origin action for exactly
 * one scope. DELETE takes one scope off, and only `token:mint-child` (the
 * switch on a token's row; every other scope stays additive here).
 */
export async function tokenScopeApi(req: Request, deps: TokenApiDeps): Promise<Response> {
  const owner = await deps.who();
  if (!owner) return json({ error: "Sign in" }, 401);
  if (req.method !== "GET" && req.method !== "POST" && req.method !== "DELETE")
    return json({ error: "Method" }, 405);
  if (req.method === "POST" && !sameOriginJsonPost(req)) return json({ error: "Forbidden" }, 403);
  if (req.method === "DELETE" && !sameOriginJson(req)) return json({ error: "Forbidden" }, 403);
  let id: unknown;
  let scope: ScopeId | null;
  if (req.method === "GET") {
    const query = new URL(req.url).searchParams;
    id = query.get("id");
    scope = scopeOf(query.get("scope"));
    if (query.getAll("id").length !== 1 || query.getAll("scope").length !== 1)
      return json({ error: "bad-request" }, 400);
  } else {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== "id" && key !== "scope")
    )
      return json({ error: "bad-request" }, 400);
    id = body.id;
    scope = scopeOf(body.scope);
  }
  if (!scope) return json({ error: "bad-scope" }, 400);
  // Child tokens off (flag tokens.child): their permission does not exist.
  if (
    scope === MINT_CHILD &&
    !(await (deps.childTokens?.() ?? Promise.resolve(false)).catch(() => false))
  )
    return json({ error: "bad-scope" }, 400);
  if (req.method === "DELETE" && scope !== MINT_CHILD) return json({ error: "bad-scope" }, 400);
  const now = (deps.now ?? Date.now)();
  const db = deps.db();
  const row = await ownLiveToken(db, owner, id, now);
  if (!row) return json({ error: "Not found" }, 404);
  if (req.method === "DELETE") {
    const updated = await removeMintChild(db, owner, row.token_hash, now);
    if (!updated) return json({ error: "Not found" }, 404);
    await audit(
      db,
      {
        kind: "api-token.scope",
        actor: owner.userId,
        subject: tagOf(row.token_hash),
        detail: `-${scope}`,
      },
      now,
    );
    // Its children's sockets close now (they are refused from here on anyway).
    const { results } = await db
      .prepare("SELECT token_hash FROM api_tokens WHERE parent_hash = ?")
      .bind(row.token_hash)
      .all<{ token_hash: string }>();
    if (results.length) await deps.revoked(results.map((r) => r.token_hash));
    return json({ ok: true, token: tokenView(updated) });
  }
  let error: "dev-required" | "expiry-too-long" | "child-token" | undefined;
  if (OWNER_SCOPES.includes(scope) && !(await deps.siteOwner?.(owner.userId)))
    error = "dev-required";
  // No grandchildren: a child token never mints, and a token with no expiry cannot bound one.
  else if (scope === MINT_CHILD && (row.parent_hash || !row.expires_at)) error = "child-token";
  else if (
    expiryCapped(scope) &&
    (!row.expires_at || Date.parse(row.expires_at) > now + EVAL_MAX_DAYS * 86_400_000)
  )
    error = "expiry-too-long";
  if (req.method === "GET")
    return json({
      token: tokenView(row),
      needScope: scope,
      granted: rowScopes(row.scopes).includes(scope),
      canApprove: !error,
      ...(error ? { error } : {}),
    });
  if (error) return json({ error }, 403);
  const updated = await appendTokenScope(db, owner, row.token_hash, scope, now);
  if (!updated) return json({ error: "Not found" }, 404);
  await audit(
    db,
    { kind: "api-token.scope", actor: owner.userId, subject: tagOf(row.token_hash), detail: scope },
    now,
  );
  return json({ ok: true, token: tokenView(updated) });
}
