/**
 * The Worker's check for box tokens and box origins, in front of OpenNext
 * (worker.ts, docs/box-oauth.md). A request with neither costs two header reads.
 *
 * What it guarantees:
 * - Flag off: a box token, a preflight and the two cross-origin provider calls
 *   all get the same answers as if none of this existed.
 * - CORS answers only a registered box's exact origin, and never allows
 *   credentials. A request carrying both a token and a cookie is refused.
 * - A token works only from its box's origin, only as the bound account, only
 *   on allowlisted routes (rules.ts), only within its scope, and rate limited.
 * - The app gets no token and no cookie: a signed one-minute identity
 *   (identity.ts), and any Set-Cookie on the way back is dropped.
 */
import { signBoxIdentity, BOX_IDENTITY_HEADER } from "./identity";
import { BOX_FLAG, BOX_TOKEN_PREFIX, isBoxOrigin, isCorsProviderPath, tokenMayCall } from "./rules";
import { bindingByOrigin, isDevUser, liveToken, type BoxDb } from "./store";

export type BoxEnv = {
  DB?: BoxDb;
  AUTH_SECRET?: string;
  NODE_ENV?: string;
};

export type GateDeps = {
  /** Reads the flag, uncached is fine: at most once per box request. */
  flagOn(db: BoxDb, key: string): Promise<boolean>;
  /** False once this token has spent its budget. */
  allow(db: BoxDb, tokenHash: string): Promise<boolean>;
  now?: () => number;
};

export function mayBeBox(req: Request): boolean {
  const h = req.headers;
  if (h.has(BOX_IDENTITY_HEADER)) return true;
  if ((h.get("authorization") ?? "").startsWith(`Bearer ${BOX_TOKEN_PREFIX}`)) return true;
  const origin = h.get("origin");
  return (
    origin !== null &&
    (origin.startsWith("https://my-") ||
      origin.endsWith(".lianki.pages.dev") ||
      origin.startsWith("http://"))
  );
}

const json = (status: number, error: string, extra?: HeadersInit) =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });

/** Exactly one origin, no credentials, and caches keep the answer per origin. */
function cors(origin: string): Record<string, string> {
  return {
    "access-control-allow-origin": origin,
    "access-control-expose-headers": BOX_EXPOSED_HEADERS,
    vary: "Origin",
  };
}

/**
 * The app's own response headers a box page reads (CORS hides all but the
 * safelisted ones otherwise): X-Voice tells the chat whether a clip is a
 * lane's own speaker (voice-out.ts) and /words a missing recording
 * (lib/words/audio-cache.ts); Retry-After a rate limit; Content-Disposition a
 * file's name (the inbox). Without it, on a box every lane clip counted as
 * fallen back to the one voice (2026-11-07).
 */
export const BOX_EXPOSED_HEADERS = "X-Voice, Retry-After, Content-Disposition";

export async function sha256B64Url(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return btoa(String.fromCharCode(...new Uint8Array(d)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** As the plugin stores an access token: the hash of the value without its prefix. */
export function boxTokenHash(token: string): Promise<string> {
  return sha256B64Url(
    token.startsWith(BOX_TOKEN_PREFIX) ? token.slice(BOX_TOKEN_PREFIX.length) : token,
  );
}

function withCors(res: Response, origin: string): Response {
  const out = new Response(res.body, res);
  out.headers.delete("set-cookie");
  out.headers.delete("access-control-allow-credentials");
  out.headers.set("access-control-allow-origin", origin);
  out.headers.set("access-control-expose-headers", BOX_EXPOSED_HEADERS);
  out.headers.append("vary", "Origin");
  return out;
}

/** A copy of the request the app may see: no cookie, no token, not cross-origin. */
function forwardable(req: Request, prodOrigin: string): Request {
  const out = new Request(req);
  for (const name of [
    "cookie",
    "authorization",
    BOX_IDENTITY_HEADER,
    "sec-fetch-site",
    "sec-fetch-mode",
    "sec-fetch-dest",
    "referer",
  ])
    out.headers.delete(name);
  out.headers.set("origin", prodOrigin);
  return out;
}

export async function boxGate(
  req: Request,
  env: BoxEnv,
  deps: GateDeps,
  next: (r: Request) => Promise<Response>,
): Promise<Response> {
  const url = new URL(req.url);
  const now = deps.now?.() ?? Date.now();

  // Only the gate may set this, on any request.
  let clean = req;
  if (req.headers.has(BOX_IDENTITY_HEADER)) {
    clean = new Request(req);
    clean.headers.delete(BOX_IDENTITY_HEADER);
  }
  if (!mayBeBox(clean)) return next(clean);

  const origin = clean.headers.get("origin");
  const dev = env.NODE_ENV === "development";
  const bearer = clean.headers.get("authorization") ?? "";
  const isToken = bearer.startsWith(`Bearer ${BOX_TOKEN_PREFIX}`);
  // This server's own pages are never a box (on localhost they would match).
  const fromBox = origin !== url.origin && isBoxOrigin(origin, dev);
  if (!isToken && !fromBox) return next(clean);
  if (!url.pathname.startsWith("/api/")) return next(clean);

  const db = env.DB;
  const on = db ? await deps.flagOn(db, BOX_FLAG).catch(() => false) : false;
  if (!on || !db) {
    if (isToken) return json(404, "Not found");
    return next(clean);
  }

  // Preflight: what a browser asks before the real request.
  if (clean.method === "OPTIONS") {
    if (!origin || !fromBox) return next(clean);
    const box = await bindingByOrigin(db, origin).catch(() => null);
    if (!box) return new Response(null, { status: 403, headers: { vary: "Origin" } });
    return new Response(null, {
      status: 204,
      headers: {
        ...cors(origin),
        "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-max-age": "600",
      },
    });
  }

  // Credentials stay off, whatever the page tried. Decide this before anything else.
  if (fromBox && (clean.headers.get("cookie") ?? "") !== "")
    return json(400, 'Send the token without cookies (credentials: "omit")');

  // The PKCE exchange, refresh and revoke, cross-origin from a box.
  if (!isToken && isCorsProviderPath(url.pathname) && clean.method === "POST") {
    const box = origin ? await bindingByOrigin(db, origin).catch(() => null) : null;
    if (!box || !origin) return json(403, "Not a registered box");
    const res = await next(forwardable(clean, url.origin));
    return withCors(res, origin);
  }

  if (!isToken) return next(clean);

  // From here on it is a box token, and there is no way back to the session.
  const m = /^Bearer (lkb_[A-Za-z0-9_-]{16,256})$/.exec(bearer);
  const fail = (status: number, error: string) =>
    json(status, error, origin && fromBox ? cors(origin) : undefined);
  if (!m) return fail(401, "Invalid token");
  const hash = await boxTokenHash(m[1]);
  // A lookup that fails is no token: closed, never through.
  const token = await liveToken(db, hash, now).catch(() => null);
  if (!token) return fail(401, "Invalid token");
  if (origin !== token.origin) return json(403, "Wrong origin for this token");
  const answer = tokenMayCall(clean.method, url.pathname, token.scopes);
  if (!answer.ok)
    return fail(
      answer.status,
      answer.reason === "scope" ? "Out of scope" : "Not available to a box",
    );
  // box:chat acts as the owner: only while the account holds `dev`, read now.
  if (answer.chat && !(await isDevUser(db, token.userId).catch(() => false)))
    return fail(403, "Out of scope");
  if (!(await deps.allow(db, hash)))
    return json(429, "Too many requests", { ...cors(origin), "retry-after": "60" });
  if (!env.AUTH_SECRET) return fail(503, "Not configured");

  const forwarded = forwardable(clean, url.origin);
  forwarded.headers.set(
    BOX_IDENTITY_HEADER,
    await signBoxIdentity(env.AUTH_SECRET, { userId: token.userId, clientId: token.clientId }, now),
  );
  return withCors(await next(forwarded), origin);
}
