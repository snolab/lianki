/**
 * OAuth sign-in for the remote MCP server, the pure part (docs/mcp-oauth.md):
 * which scopes an app may get, what a registration may hold, the authorize
 * request's checks, PKCE, and the two metadata documents. No I/O here.
 *
 * Separate from the box provider (lib/box-oauth/*) on purpose: that one is
 * better-auth's plugin, shut to everything but bound boxes, with no consent and
 * no registration. An app here registers itself and the user consents, and the
 * access token it gets is an ordinary `lk_` API token (lib/api-tokens.ts), so
 * every route checks it as it checks any other.
 */
import { SCOPE_IDS, type ScopeId, cleanTokenName } from "@/lib/api-tokens";

export const MCP_OAUTH_FLAG = "mcp.oauth" as const;

/** Where the MCP server lives, relative to the site's origin (workers/mcp). */
export const MCP_RESOURCE_PATH = "/mcp";
/** The consent page: a noun with its action below it (docs/url-principles.md). */
export const AUTHORIZE_PATH = "/my/connected-apps/new";
export const TOKEN_PATH = "/api/mcp-oauth/token";
export const REGISTER_PATH = "/api/mcp-oauth/register";
export const REVOKE_PATH = "/api/mcp-oauth/revoke";
export const CONSENT_PATH = "/api/mcp-oauth/consent";
export const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
export const AUTH_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";

/**
 * What an app may ever be given, default-deny: the account's cards and the
 * Learning Partner chat. Never the owner's powers (eval, progress,
 * recordings), nothing that spends credits (mic:polish) or plays sound on the
 * user's phone (chat:play), and no publishing. A new scope stays out until it
 * is added here.
 */
export const MCP_OAUTH_SCOPES: readonly ScopeId[] = [
  "study",
  "chat:read",
  "chat:write",
  "chat:ask",
];

export const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

export const CLIENT_ID_PREFIX = "lkc_";
export const CLIENT_SECRET_PREFIX = "lkcs_";
export const REFRESH_PREFIX = "lkm_";
export const CLIENT_ID_RE = /^lkc_[0-9a-f]{32}$/;
export const REFRESH_RE = /^lkm_[0-9a-f]{64}$/;
export const CODE_RE = /^[0-9a-f]{64}$/;

export const MAX_REDIRECT_URIS = 5;
export const MAX_URI = 512;
export const MAX_STATE = 1024;
/** The longest registration body read. */
export const MAX_REGISTER_BODY = 16_384;

export function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A redirect URI an app may register: https with a host, or http on the
 * loopback (desktop apps, RFC 8252). No fragment, no user info, no custom
 * scheme. Matched exactly later, so no normalising here beyond parsing.
 */
export function redirectUriOk(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URI) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash || raw.includes("#") || u.username || u.password) return false;
  if (u.protocol === "https:") return u.hostname.length > 0;
  if (u.protocol === "http:") return LOOPBACK.has(u.hostname);
  return false;
}

export type Registration = {
  name: string;
  redirectUris: string[];
  authMethod: AuthMethod;
};

/**
 * An RFC 7591 registration request, or the error to answer. The name is the
 * app's own claim: the consent page shows it with the redirect host beside it.
 */
export function parseRegistration(
  body: unknown,
): { ok: true; value: Registration } | { ok: false; error: string; description: string } {
  const bad = (error: string, description: string) => ({ ok: false as const, error, description });
  if (!body || typeof body !== "object" || Array.isArray(body))
    return bad("invalid_client_metadata", "a JSON object is required");
  const b = body as Record<string, unknown>;
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS)
    return bad("invalid_redirect_uri", `1 to ${MAX_REDIRECT_URIS} redirect_uris are required`);
  if (!uris.every(redirectUriOk))
    return bad("invalid_redirect_uri", "each redirect URI must be https, or http on the loopback");
  const method = b.token_endpoint_auth_method ?? "client_secret_basic";
  if (!(AUTH_METHODS as readonly unknown[]).includes(method))
    return bad("invalid_client_metadata", "token_endpoint_auth_method is not supported");
  const grants = b.grant_types ?? ["authorization_code"];
  if (
    !Array.isArray(grants) ||
    !grants.every((g) => g === "authorization_code" || g === "refresh_token")
  )
    return bad("invalid_client_metadata", "only authorization_code and refresh_token");
  const responses = b.response_types ?? ["code"];
  if (!Array.isArray(responses) || !responses.every((r) => r === "code"))
    return bad("invalid_client_metadata", "only the code response type");
  const host = new URL(uris[0] as string).host;
  const name = cleanTokenName(b.client_name) ?? cleanTokenName(host) ?? "app";
  return {
    ok: true,
    value: { name, redirectUris: [...new Set(uris as string[])], authMethod: method as AuthMethod },
  };
}

/** A space-separated scope string, narrowed to what an app may get; none asked = all of them. */
export function offeredScopes(raw: string | null | undefined): ScopeId[] {
  const asked = new Set((raw ?? "").split(/\s+/).filter(Boolean));
  const known = MCP_OAUTH_SCOPES.filter((s) => asked.has(s));
  return known.length ? known : [...MCP_OAUTH_SCOPES];
}

/** What the user ticked, kept to what was offered. */
export function chosenScopes(ticked: readonly string[], offered: readonly ScopeId[]): ScopeId[] {
  const t = new Set(ticked);
  return SCOPE_IDS.filter((s) => offered.includes(s) && t.has(s));
}

export const scopeString = (scopes: readonly string[]) => scopes.join(" ");

/**
 * The issuer and resource origin for a request's host: https, except plain
 * http on a local server. One rule for the pages and the routes, which see
 * the scheme differently behind a proxy; the issuer must match exactly
 * (RFC 9207). An odd host falls back to lianki.com.
 */
export function originFor(host: string | null | undefined): string {
  const h = host && /^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(host) ? host.toLowerCase() : "lianki.com";
  return /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(h) ? `http://${h}` : `https://${h}`;
}

/** The MCP server's canonical address on this origin (RFC 8707 `resource`). */
export const resourceOf = (origin: string) => `${origin}${MCP_RESOURCE_PATH}`;

/** Is `raw` this server's resource (with or without a trailing slash)? Absent counts as yes. */
export function resourceOk(raw: string | null | undefined, origin: string): boolean {
  if (raw === null || raw === undefined || raw === "") return true;
  const want = resourceOf(origin);
  return raw === want || raw === `${want}/`;
}

/** RFC 7636: S256(verifier), base64url without padding. */
export async function s256(verifier: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let bin = "";
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
export const CHALLENGE_RE = /^[A-Za-z0-9\-_]{43}$/;

export async function pkceOk(verifier: unknown, challenge: string): Promise<boolean> {
  if (typeof verifier !== "string" || !VERIFIER_RE.test(verifier)) return false;
  return (await s256(verifier)) === challenge;
}

export type Client = {
  clientId: string;
  name: string;
  redirectUris: string[];
  authMethod: AuthMethod;
  secretHash: string | null;
};

export type AuthorizeRequest = {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string | null;
  scopes: ScopeId[];
  resource: string | null;
};

export const AUTHORIZE_PARAMS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "state",
  "scope",
  "resource",
] as const;

/** The redirect back to the app (RFC 6749 4.1.2, RFC 9207 `iss`). */
export function redirectBack(
  redirectUri: string,
  params: Record<string, string | null>,
  issuer: string,
): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v);
  u.searchParams.set("iss", issuer);
  return u.toString();
}

/**
 * Check an authorize request against its client. An unknown client or a
 * redirect URI it did not register is `fatal`: shown on lianki.com, never
 * redirected (RFC 6749 4.1.2.1). Anything else wrong goes back to the app as
 * an error. `client` is the registered app, or null.
 */
export function checkAuthorize(
  q: { get(name: string): string | null },
  client: Client | null,
  origin: string,
):
  | { kind: "fatal" }
  | { kind: "error"; redirect: string }
  | { kind: "ok"; request: AuthorizeRequest; client: Client } {
  if (!client || q.get("client_id") !== client.clientId) return { kind: "fatal" };
  const asked = q.get("redirect_uri");
  const redirectUri =
    asked ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) return { kind: "fatal" };
  const state = q.get("state");
  if (state !== null && state.length > MAX_STATE) return { kind: "fatal" };
  const fail = (error: string, description: string) => ({
    kind: "error" as const,
    redirect: redirectBack(redirectUri, { error, error_description: description, state }, origin),
  });
  if (q.get("response_type") !== "code")
    return fail("unsupported_response_type", "only response_type=code");
  const challenge = q.get("code_challenge");
  if (!challenge || !CHALLENGE_RE.test(challenge) || q.get("code_challenge_method") !== "S256")
    return fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
  const resource = q.get("resource");
  if (!resourceOk(resource, origin)) return fail("invalid_target", "unknown resource");
  return {
    kind: "ok",
    client,
    request: {
      clientId: client.clientId,
      redirectUri,
      challenge,
      state,
      scopes: offeredScopes(q.get("scope")),
      resource: resource || null,
    },
  };
}

/** RFC 9728: what /mcp is and who issues its tokens. */
export function protectedResourceMetadata(origin: string) {
  return {
    resource: resourceOf(origin),
    authorization_servers: [origin],
    scopes_supported: [...MCP_OAUTH_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Lianki",
    resource_documentation: `${origin}/mcp`,
  };
}

/** RFC 8414: the authorization server. Issuer = the origin, exactly. */
export function authServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}${AUTHORIZE_PATH}`,
    token_endpoint: `${origin}${TOKEN_PATH}`,
    registration_endpoint: `${origin}${REGISTER_PATH}`,
    revocation_endpoint: `${origin}${REVOKE_PATH}`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [...AUTH_METHODS],
    revocation_endpoint_auth_methods_supported: [...AUTH_METHODS],
    scopes_supported: [...MCP_OAUTH_SCOPES],
    // Every authorization response, errors included, carries `iss` (redirectBack).
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${origin}/mcp`,
  };
}

/** The client's credentials from a token or revoke request (RFC 6749 2.3.1). */
export function clientCredentials(
  headers: { get(name: string): string | null },
  form: URLSearchParams,
): { clientId: string | null; secret: string | null; method: AuthMethod } | null {
  const h = headers.get("authorization");
  if (h) {
    const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(h.trim());
    if (!m) return null;
    let decoded: string;
    try {
      decoded = atob(m[1]);
    } catch {
      return null;
    }
    const i = decoded.indexOf(":");
    if (i < 0) return null;
    try {
      const id = decodeURIComponent(decoded.slice(0, i).replace(/\+/g, " "));
      const secret = decodeURIComponent(decoded.slice(i + 1).replace(/\+/g, " "));
      const bodyId = form.get("client_id");
      if (bodyId !== null && bodyId !== id) return null;
      return { clientId: id, secret, method: "client_secret_basic" };
    } catch {
      return null;
    }
  }
  const secret = form.get("client_secret");
  return {
    clientId: form.get("client_id"),
    secret,
    method: secret !== null ? "client_secret_post" : "none",
  };
}
