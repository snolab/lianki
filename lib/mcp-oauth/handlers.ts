/**
 * OAuth sign-in for the remote MCP server, the HTTP part (docs/mcp-oauth.md).
 * Each export is one route's whole answer, with its I/O passed in, so the
 * tests drive them as the routes do. With the flag off every one but the
 * account's own list answers 404, as if it did not exist.
 */
import type { D1Like } from "@/lib/d1/types";
import type { ScopeId } from "@/lib/api-tokens";
import { jsonWrite } from "@/lib/api-token-api";
import {
  AUTHORIZE_PARAMS,
  CONSENT_PATH,
  MAX_REGISTER_BODY,
  authServerMetadata,
  checkAuthorize,
  originFor,
  chosenScopes,
  clientCredentials,
  parseRegistration,
  protectedResourceMetadata,
  redirectBack,
  resourceOk,
  pkceOk,
  scopeString,
  type AuthorizeRequest,
  type Client,
} from "./rules";
import {
  clientAuthOk,
  createCode,
  getClient,
  issueGrant,
  listGrants,
  liveUser,
  refreshGrant,
  registerClient,
  revokeByToken,
  revokeGrant,
  takeCode,
  type Issued,
  type Lifetimes,
} from "./store";

export type OAuthLimits = {
  accessMin: number;
  refreshDays: number;
  codeSeconds: number;
  registerPerHour: number;
  tokenPerMin: number;
};

export type OAuthDeps = {
  /** D1, or null off the D1 backend (then nothing here exists). */
  db: () => D1Like | null;
  flagOn: () => Promise<boolean>;
  limits: () => Promise<OAuthLimits>;
  /** One hit on a counter; false = over the limit. */
  allow: (key: string, max: number, windowMs: number) => Promise<boolean>;
  /** The signed-in account, from the session cookie only. */
  user: () => Promise<{ id: string; email: string } | null>;
  /** Close the chat hub's sockets of tokens that ended. */
  revoked: (ids: string[]) => Promise<void>;
  ip: (req: Request) => string;
  now: () => number;
};

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };
/** Apps call these from servers and from browsers; never with credentials. */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
  "access-control-max-age": "600",
};

const notFound = () => new Response(null, { status: 404, headers: NO_STORE });
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...NO_STORE, ...CORS, ...extra } });
const oauthError = (error: string, description: string, status = 400, extra = {}) =>
  json({ error, error_description: description }, status, extra);

export const preflight = () => new Response(null, { status: 204, headers: CORS });

async function live(deps: OAuthDeps): Promise<D1Like | null> {
  const db = deps.db();
  if (!db) return null;
  return (await deps.flagOn()) ? db : null;
}

const lifetimes = (l: OAuthLimits): Lifetimes => ({
  accessMs: l.accessMin * 60_000,
  refreshMs: l.refreshDays * 86_400_000,
});

const originOf = (req: Request) => originFor(new URL(req.url).host);

/** GET /.well-known/oauth-protected-resource[/mcp] and /.well-known/oauth-authorization-server. */
export async function metadata(
  req: Request,
  kind: "protected-resource" | "authorization-server",
  deps: OAuthDeps,
): Promise<Response> {
  if (!(await live(deps))) return notFound();
  const origin = originOf(req);
  const body =
    kind === "protected-resource" ? protectedResourceMetadata(origin) : authServerMetadata(origin);
  return Response.json(body, {
    headers: { ...CORS, "cache-control": "public, max-age=300" },
  });
}

/** POST /api/mcp-oauth/register — RFC 7591 dynamic client registration, open, rate-limited per IP. */
export async function register(req: Request, deps: OAuthDeps): Promise<Response> {
  const db = await live(deps);
  if (!db) return notFound();
  const limits = await deps.limits();
  if (
    !(await deps.allow(`mcp-oauth-register:ip:${deps.ip(req)}`, limits.registerPerHour, 3_600_000))
  )
    return oauthError("slow_down", "too many registrations", 429);
  const text = await req.text();
  if (text.length > MAX_REGISTER_BODY)
    return oauthError("invalid_client_metadata", "request too large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return oauthError("invalid_client_metadata", "JSON is required");
  }
  const reg = parseRegistration(body);
  if (!reg.ok) return oauthError(reg.error, reg.description);
  const { clientId, secret, createdAt } = await registerClient(db, reg.value, deps.now());
  return json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(createdAt / 1000),
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_name: reg.value.name,
      redirect_uris: reg.value.redirectUris,
      token_endpoint_auth_method: reg.value.authMethod,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    201,
  );
}

async function formOf(req: Request): Promise<URLSearchParams | null> {
  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  const text = await req.text();
  if (text.length > MAX_REGISTER_BODY) return null;
  if (type.startsWith("application/json")) {
    try {
      const o = JSON.parse(text);
      if (!o || typeof o !== "object" || Array.isArray(o)) return null;
      const f = new URLSearchParams();
      for (const [k, v] of Object.entries(o)) if (typeof v === "string") f.set(k, v);
      return f;
    } catch {
      return null;
    }
  }
  return new URLSearchParams(text);
}

/** The token or revoke request's client, authenticated as it registered; else null. */
async function authedClient(
  req: Request,
  form: URLSearchParams,
  db: D1Like,
): Promise<Client | null> {
  const cred = clientCredentials(req.headers, form);
  if (!cred?.clientId) return null;
  const client = await getClient(db, cred.clientId);
  if (!client || !(await clientAuthOk(client, cred))) return null;
  return client;
}

const tokenAnswer = (t: Issued) =>
  json({
    access_token: t.accessToken,
    token_type: "Bearer",
    expires_in: t.expiresIn,
    refresh_token: t.refreshToken,
    scope: scopeString(t.scopes),
  });

/** POST /api/mcp-oauth/token — authorization_code (PKCE S256) and refresh_token. */
export async function token(req: Request, deps: OAuthDeps): Promise<Response> {
  const db = await live(deps);
  if (!db) return notFound();
  const limits = await deps.limits();
  if (!(await deps.allow(`mcp-oauth-token:ip:${deps.ip(req)}`, limits.tokenPerMin, 60_000)))
    return oauthError("slow_down", "too many requests", 429);
  const form = await formOf(req);
  if (!form) return oauthError("invalid_request", "a form body is required");
  const client = await authedClient(req, form, db);
  if (!client)
    return oauthError("invalid_client", "client authentication failed", 401, {
      "www-authenticate": 'Basic realm="lianki"',
    });
  const now = deps.now();
  const origin = originOf(req);
  if (!resourceOk(form.get("resource"), origin))
    return oauthError("invalid_target", "unknown resource");
  const grant = form.get("grant_type");
  if (grant === "authorization_code") {
    // Taken first: a code works once, even when this exchange fails.
    const code = await takeCode(db, form.get("code"));
    if (!code || code.client_id !== client.clientId)
      return oauthError("invalid_grant", "unknown, used or another app's code");
    if (!(Date.parse(code.expires_at) > now)) return oauthError("invalid_grant", "code expired");
    if (form.get("redirect_uri") !== null && form.get("redirect_uri") !== code.redirect_uri)
      return oauthError("invalid_grant", "redirect_uri does not match");
    if (!(await pkceOk(form.get("code_verifier"), code.challenge)))
      return oauthError("invalid_grant", "code_verifier does not match");
    const r = form.get("resource");
    if (r && code.resource && r.replace(/\/$/, "") !== code.resource.replace(/\/$/, ""))
      return oauthError("invalid_target", "resource does not match");
    const user = await liveUser(db, code.user_id);
    if (!user) return oauthError("invalid_grant", "the account is gone");
    const scopes = JSON.parse(code.scopes) as ScopeId[];
    return tokenAnswer(await issueGrant(db, client, user, scopes, lifetimes(limits), now));
  }
  if (grant === "refresh_token") {
    const t = await refreshGrant(db, client, form.get("refresh_token"), lifetimes(limits), now);
    if (!t) return oauthError("invalid_grant", "unknown, used or expired refresh token");
    return tokenAnswer(t);
  }
  return oauthError("unsupported_grant_type", "authorization_code or refresh_token");
}

/** POST /api/mcp-oauth/revoke — RFC 7009. Always 200 for an authenticated client. */
export async function revoke(req: Request, deps: OAuthDeps): Promise<Response> {
  const db = await live(deps);
  if (!db) return notFound();
  const limits = await deps.limits();
  if (!(await deps.allow(`mcp-oauth-token:ip:${deps.ip(req)}`, limits.tokenPerMin, 60_000)))
    return oauthError("slow_down", "too many requests", 429);
  const form = await formOf(req);
  if (!form) return oauthError("invalid_request", "a form body is required");
  const client = await authedClient(req, form, db);
  if (!client) return oauthError("invalid_client", "client authentication failed", 401);
  const ids = await revokeByToken(db, client, form.get("token"));
  if (ids.length) await deps.revoked(ids);
  return new Response(null, { status: 200, headers: { ...NO_STORE, ...CORS } });
}

export type AuthorizeView =
  | { kind: "not-found" }
  | { kind: "sign-in"; back: string }
  | { kind: "invalid" }
  | { kind: "redirect"; to: string }
  | {
      kind: "consent";
      client: Client;
      request: AuthorizeRequest;
      host: string;
      email: string;
      /** The parameters to carry in the form, as received. */
      fields: [string, string][];
      action: string;
    };

/** The consent page's decision (app/(app)/my/connected-apps/new). Opening it changes nothing. */
export async function authorizeView(
  search: URLSearchParams,
  origin: string,
  path: string,
  deps: OAuthDeps,
): Promise<AuthorizeView> {
  const db = await live(deps);
  if (!db) return { kind: "not-found" };
  const client = await getClient(db, search.get("client_id"));
  const c = checkAuthorize(search, client, origin);
  if (c.kind === "fatal") return { kind: "invalid" };
  if (c.kind === "error") return { kind: "redirect", to: c.redirect };
  const fields: [string, string][] = [];
  for (const k of AUTHORIZE_PARAMS) {
    const v = search.get(k);
    if (v !== null) fields.push([k, v]);
  }
  const user = await deps.user();
  if (!user) return { kind: "sign-in", back: `${path}?${new URLSearchParams(fields)}` };
  return {
    kind: "consent",
    client: c.client,
    request: c.request,
    host: new URL(c.request.redirectUri).host,
    email: user.email,
    fields,
    action: CONSENT_PATH,
  };
}

/**
 * POST /api/mcp-oauth/consent — the consent form, Allow or Deny. Only the
 * user's own click on lianki.com's page counts: a top-level, same-origin,
 * user-activated navigation (Fetch Metadata, which a page's script cannot set),
 * so script on a lianki.com page cannot mint a code by itself. The request is
 * checked again from scratch; the code goes only to the registered redirect URI.
 */
export async function consent(req: Request, deps: OAuthDeps): Promise<Response> {
  const db = await live(deps);
  if (!db) return notFound();
  const origin = originOf(req);
  const h = req.headers;
  if (
    h.get("origin") !== origin ||
    h.get("sec-fetch-site") !== "same-origin" ||
    h.get("sec-fetch-mode") !== "navigate" ||
    h.get("sec-fetch-dest") !== "document" ||
    h.get("sec-fetch-user") !== "?1"
  )
    return new Response("Forbidden", { status: 403, headers: NO_STORE });
  const form = new URLSearchParams((await req.text()).slice(0, MAX_REGISTER_BODY));
  const user = await deps.user();
  if (!user) return new Response("Sign in first", { status: 401, headers: NO_STORE });
  const client = await getClient(db, form.get("client_id"));
  const c = checkAuthorize(form, client, origin);
  if (c.kind === "fatal")
    return new Response("Invalid request", { status: 400, headers: NO_STORE });
  const to = (url: string) =>
    new Response(null, { status: 303, headers: { ...NO_STORE, location: url } });
  if (c.kind === "error") return to(c.redirect);
  const { request } = c;
  const scopes = chosenScopes(form.getAll("grant"), request.scopes);
  if (form.get("decision") !== "allow" || scopes.length === 0)
    return to(
      redirectBack(
        request.redirectUri,
        { error: "access_denied", error_description: "the user declined", state: request.state },
        origin,
      ),
    );
  const limits = await deps.limits();
  const code = await createCode(
    db,
    request,
    user.id,
    scopes,
    limits.codeSeconds * 1000,
    deps.now(),
  );
  return to(redirectBack(request.redirectUri, { code, state: request.state }, origin));
}

/**
 * /api/my/connected-apps — the signed-in account's connected apps: GET lists,
 * DELETE {id} disconnects one. Works with the flag off too, so access can
 * always be cleaned up.
 */
export async function myApps(req: Request, deps: OAuthDeps): Promise<Response> {
  const db = deps.db();
  if (!db) return Response.json({ error: "not-available" }, { status: 503, headers: NO_STORE });
  const user = await deps.user();
  if (!user) return Response.json({ error: "login-required" }, { status: 401, headers: NO_STORE });
  if (req.method === "GET")
    return Response.json(
      { enabled: await deps.flagOn(), apps: await listGrants(db, user.id) },
      { headers: NO_STORE },
    );
  if (req.method !== "DELETE")
    return Response.json({ error: "method-not-allowed" }, { status: 405, headers: NO_STORE });
  if (!jsonWrite(req))
    return Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  let id: unknown;
  try {
    id = ((await req.json()) as { id?: unknown })?.id;
  } catch {
    return Response.json({ error: "bad-request" }, { status: 400, headers: NO_STORE });
  }
  const ids = await revokeGrant(db, user.id, id);
  if (!ids) return Response.json({ error: "not-found" }, { status: 404, headers: NO_STORE });
  if (ids.length) await deps.revoked(ids);
  return Response.json({ ok: true }, { headers: NO_STORE });
}
