/**
 * Pure rules for signing a my-<hash> box in through lianki.com
 * (docs/box-oauth.md). No imports, so the Worker's gate, the auth route and the
 * tests all read the same lists. Everything is deny by default.
 */

/** The dark flag. docs/feature-flags.md. */
export const BOX_FLAG = "box.oauth";

export const BOX_TOKEN_PREFIX = "lkb_";
export const SCOPE_READ = "box:read";
export const SCOPE_WRITE = "box:write";
export const SCOPE_REFRESH = "offline_access";
/** Scopes a box may hold, in the plugin's terms. */
export const BOX_SCOPES = [SCOPE_READ, SCOPE_WRITE, SCOPE_REFRESH] as const;

export const ACCESS_TOKEN_SECONDS = 15 * 60;
export const REFRESH_TOKEN_SECONDS = 24 * 60 * 60;
export const CODE_SECONDS = 60;

/** Each box's one redirect URI is its origin plus this. */
export const BOX_CALLBACK_PATH = "/box-callback";
/** lianki.com's entry to the flow; it signs the user in, then goes to the plugin. */
export const BOX_AUTHORIZE_PATH = "/box-authorize";

const BOX_ORIGIN = /^https:\/\/my-[0-9a-f]{12,64}\.lianki\.com$/;
const LOCAL_ORIGIN = /^http:\/\/127\.0\.0\.1:[0-9]{2,5}$/;

/** A box's origin as the browser sends it: my-<hash>, or 127.0.0.1 on a dev server only. */
export function isBoxOrigin(origin: string | null | undefined, dev = false): boolean {
  if (!origin) return false;
  return BOX_ORIGIN.test(origin) || (dev && LOCAL_ORIGIN.test(origin));
}

export const redirectUriFor = (origin: string) => `${origin}${BOX_CALLBACK_PATH}`;

/**
 * The only plugin routes that answer over HTTP, all under /api/auth. The plugin
 * also mounts client CRUD for any signed-in user, dynamic registration, consent
 * management, secret rotation, admin and discovery: none of those is needed, so
 * each is a 404 (app/api/auth/[...all]/route.ts). Consent is off: the owner's
 * binding is the grant.
 */
const PROVIDER_PATHS = new Set(["/oauth2/authorize", "/oauth2/token", "/oauth2/revoke"]);

/** Paths the plugin owns, whether or not they are open. */
export function isProviderPath(authPath: string): boolean {
  const p = authPath.toLowerCase();
  return (
    p === "/oauth2" ||
    p.startsWith("/oauth2/") ||
    p.startsWith("/admin/oauth2") ||
    p.startsWith("/.well-known/")
  );
}

export function isOpenProviderPath(authPath: string): boolean {
  return PROVIDER_PATHS.has(authPath);
}

/** /api/auth/oauth2/token -> /oauth2/token */
export function authPathOf(pathname: string): string {
  return pathname.replace(/^\/api\/auth(?=\/|$)/, "");
}

/** The two the browser calls cross-origin from a box. */
export function isCorsProviderPath(pathname: string): boolean {
  return pathname === "/api/auth/oauth2/token" || pathname === "/api/auth/oauth2/revoke";
}

/**
 * The GETs that write: grading, deleting, and the legacy /repeat page, which
 * adds the card its `url` names (app/fsrs.ts). A read-only token may not use
 * them, and another subdomain's page may not trigger them with a cookie.
 */
export function isMutatingGet(pathname: string): boolean {
  return /^\/api\/fsrs\/(review\/|delete(\/|$)|repeat(\/|$))/i.test(pathname);
}

/**
 * A token reaches only these: the study data of the account it belongs to. Not
 * on the list means refused, so a new route stays closed until someone adds it
 * here. Never admin or owner routes (/api/dev*, /api/debug), payments and
 * membership changes, API tokens, CLI login, previews, BYOK, connections, or
 * better-auth (email and login changes). `readOnly` routes take no writes even
 * with box:write.
 */
const ALLOWED: readonly { prefix: string; readOnly?: boolean }[] = [
  { prefix: "/api/fsrs" },
  { prefix: "/api/words" },
  { prefix: "/api/read" },
  { prefix: "/api/books" },
  { prefix: "/api/roadmap" },
  { prefix: "/api/polyglot" },
  { prefix: "/api/prefs" },
  { prefix: "/api/preferences" },
  { prefix: "/api/translate" },
  { prefix: "/api/tts" },
  { prefix: "/api/levels", readOnly: true },
  { prefix: "/api/lian", readOnly: true },
  { prefix: "/api/membership", readOnly: true },
];

/** Paths under an allowed prefix that are still closed to a token. */
const DENIED_WITHIN: readonly RegExp[] = [
  /^\/api\/read\/gdoc(\/|$)/, // needs the account's Google Drive connection
];

/** Anything a path could use to mean something else further in. Case is kept: routes are exact. */
function suspiciousPath(pathname: string): boolean {
  return /[%\\]|\/\/|\/\.\.?(\/|$)|[\u0000-\u001f\u007f]/.test(pathname);
}

const READ_METHODS = new Set(["GET", "HEAD"]);
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type RouteAnswer =
  | { ok: true }
  | { ok: false; status: 403 | 404 | 405; reason: "path" | "method" | "scope" };

/** May a token with these scopes make this request? */
export function tokenMayCall(
  method: string,
  pathname: string,
  scopes: readonly string[],
): RouteAnswer {
  if (suspiciousPath(pathname)) return { ok: false, status: 404, reason: "path" };
  const route = ALLOWED.find((r) => pathname === r.prefix || pathname.startsWith(`${r.prefix}/`));
  if (!route || DENIED_WITHIN.some((re) => re.test(pathname)))
    return { ok: false, status: 404, reason: "path" };
  const m = method.toUpperCase();
  const reads = READ_METHODS.has(m) && !isMutatingGet(pathname);
  const writes = WRITE_METHODS.has(m) || (READ_METHODS.has(m) && isMutatingGet(pathname));
  if (!reads && !writes) return { ok: false, status: 405, reason: "method" };
  if (writes && route.readOnly) return { ok: false, status: 403, reason: "method" };
  const allowed = writes
    ? scopes.includes(SCOPE_WRITE)
    : scopes.includes(SCOPE_READ) || scopes.includes(SCOPE_WRITE);
  return allowed ? { ok: true } : { ok: false, status: 403, reason: "scope" };
}

/**
 * The plugin's authorize route answers only this: a top-level navigation by
 * lianki.com's own entry page. Its answer holds a one-time code, and it gives
 * that as JSON to any fetch. So without this, JS running on lianki.com with the
 * user's session (a ?live custom frontend, docs/custom-frontend.md) could read a
 * code with its own PKCE verifier and mint a token that outlives the preview.
 * Headers a page's JS cannot set. A browser that sends none is refused too.
 */
export function isFirstPartyNavigation(headers: { get(name: string): string | null }): boolean {
  return (
    headers.get("sec-fetch-mode") === "navigate" &&
    headers.get("sec-fetch-dest") === "document" &&
    headers.get("sec-fetch-site") === "same-origin"
  );
}

/** The parameters of lianki.com's entry, rebuilt so nothing else rides along. */
const AUTHORIZE_PARAMS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
] as const;

export function cleanAuthorizeQuery(search: URLSearchParams): URLSearchParams | null {
  const out = new URLSearchParams();
  for (const k of AUTHORIZE_PARAMS) {
    const v = search.get(k);
    if (!v || v.length > 500) return null;
    out.set(k, v);
  }
  if (out.get("response_type") !== "code" || out.get("code_challenge_method") !== "S256")
    return null;
  return out;
}

/** Scopes as a clean list from whatever the store holds (JSON array or space-separated). */
export function parseScopes(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === "string");
  if (typeof raw !== "string") return [];
  const t = raw.trim();
  if (t.startsWith("[")) {
    try {
      return parseScopes(JSON.parse(t));
    } catch {
      return [];
    }
  }
  return t ? t.split(/\s+/) : [];
}
