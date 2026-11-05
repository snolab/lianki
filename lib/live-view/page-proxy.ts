/**
 * The same-origin live preview (docs/live-view.md, "Same-origin pages"):
 * lianki.com serves the owner a page from his dev server when the address
 * carries `?live=<id>`, while /api and /auth always stay on production.
 * Owner's approval: Slack, 2026-11-05 13:01 JST ("go").
 *
 * It runs in the main Worker's fetch, before OpenNext (worker.ts). A request
 * with no `live=` in its URL and no live cookie goes straight to OpenNext:
 * two string checks (`mayBeLive`). Otherwise:
 *
 * - **A document with `?live=<id>`**: the viewer must be the owner (his
 *   session, asked of the app's own /api/dev/whoami) and `<id>` the serial of
 *   the stored, verified live-view pointer, which must name a `page` origin
 *   (lib/live-view/rules.ts). Then the page comes from that origin (the gate
 *   in front of his dev server, scripts/dev/preview-gate.ts, entered with the
 *   Worker's own secret, LIVE_GATE_SECRET), and a host-only, Secure,
 *   HttpOnly, SameSite=Lax cookie is set: idle 1 h, never past the pointer.
 *   Anyone else gets the normal page, untouched.
 * - **The cookie is for subresources only**: /_next/* (the dev chunks), the
 *   HMR websocket, and the router's RSC fetches whose Referer still carries
 *   `?live=<id>` (so another, normal tab is never switched). Nothing else is
 *   ever proxied: never /api, /auth or /_lk, never a POST, never a service
 *   worker script.
 * - **A document without `?live`** clears the cookie; `?live=off` clears it
 *   and drops the parameter.
 * - **What goes up**: an allow-list of request headers, never the viewer's
 *   Cookie, Authorization, cf-*, x-forwarded-* or Referer; Origin is the
 *   tunnel's. The URL is the pointer's origin with only the path and query
 *   set, after refusing `//`, backslashes, encoded slashes and `@` tricks, and
 *   checked to still be that origin.
 * - **What comes down**: filtered (lib/live-view/tunnel-headers.ts: no
 *   Set-Cookie, CSP, CORS, HSTS, Clear-Site-Data), marked (no-store,
 *   `x-lk-live: <id>`, frame-ancestors 'self'), redirects on the tunnel (or
 *   relative) kept on lianki.com, and documents get a small "LIVE · stop"
 *   badge whose script keeps `?live=<id>` on in-app navigations and stops a
 *   reload storm.
 * - **The tunnel down or slow**: the normal production page with a small
 *   "预览不可用" notice, never a 502.
 *
 * **Custom frontends** (`?live=<22-character id>`, lib/live-view/custom.ts,
 * docs/custom-frontend.md) take the same path with stricter rules: the id is
 * served only to the signed-in user who registered it (asked of the app's own
 * /api/live-previews/<id> with the viewer's Cookie; anyone else gets the
 * normal page and the live cookie cleared); nothing secret goes up, not even
 * the gate secret; every response carries a strict CSP (customCsp), and the
 * document's inline scripts get its nonce. Their cookie (`c.…`, sealed, bound
 * to the session) is re-checked against D1 on every subresource, so a revoke,
 * an allowlist removal or the flag turned off ends it within 5 s. While that
 * cookie is set, the few account-level writes (minting tokens, /api/dev,
 * better-auth's account changes) are refused (customFrontendBlocked).
 */
import {
  activeForCookie,
  cspNonce,
  customCsp,
  customTarget,
  isCustomId,
  openCustomCookie,
  sealCustomCookie,
  sessionTag,
  sessionToken,
  type CustomPreview,
} from "./custom";
import { LIVE_VIEW_PUBLIC_KEYS } from "./keys";
import { importLiveViewPublicKey, liveLabel, verifyLiveView } from "./rules";
import {
  LIVE_GATE_HEADER,
  filterTunnelFetchHeaders,
  isServiceWorkerScript,
} from "./tunnel-headers";

export { LIVE_GATE_HEADER };
export const LIVE_PARAM = "live";
/** `__Host-`: Secure, Path=/, no Domain — lianki.com only, never a subdomain. */
export const LIVE_COOKIE = "__Host-lk_live";
export const LIVE_ID_HEADER = "x-lk-live";
/** The cookie lapses after this long without a live document load. */
export const LIVE_IDLE_MS = 60 * 60 * 1000;
/** LIVE_GATE_SECRET shorter than this keeps the whole feature off. */
export const LIVE_SECRET_MIN = 32;
/** A dev page's first compile can take a while; past this, production. */
export const DOC_TIMEOUT_MS = 20_000;
export const ASSET_TIMEOUT_MS = 30_000;
/** The stored pointer is re-read at most this often per isolate (a revoke lands within it). */
export const POINTER_CACHE_MS = 5_000;
/**
 * The badge's reload-storm guard: this many loads within this window switch
 * to ?live=off. The same numbers as the dev server's own guard against a
 * Turbopack restart loop (RestartStorm in scripts/dev/whole-page-guard.ts:
 * 6 restarts within 20 s).
 */
export const STORM_LOADS = 6;
export const STORM_WINDOW_MS = 20_000;

export type LiveDb = {
  prepare(q: string): { bind(...v: unknown[]): { first<T>(): Promise<T | null> } };
};
export type LiveEnv = { DB?: LiveDb; LIVE_GATE_SECRET?: string };

export type LivePage = { serial: number; page: string; exp: number; label: string };

/** Production for one request: OpenNext's handler. */
export type Next = (req: Request) => Promise<Response>;

export type LiveDeps = {
  fetch?: (req: Request) => Promise<Response>;
  now?: () => number;
  /** Trusted pointer keys (tests); default: lib/live-view/keys.ts. */
  keys?: () => Promise<CryptoKey[]>;
  /** Is this request the owner's session? Default: the app's /api/dev/whoami. */
  isOwner?: (req: Request) => Promise<boolean>;
  /** A 101 for an upgraded socket (the Workers runtime; tests pass their own). */
  respond101?: (up: Response, headers: Headers) => Response;
  /** Dev builds and tests may point at http://localhost. */
  allowLocal?: boolean;
  /**
   * A custom frontend's preview, for this viewer only (null for anyone else).
   * Default: the app's own GET /api/live-previews/<id>, with the viewer's Cookie.
   */
  resolveCustom?: (req: Request, id: string) => Promise<ResolvedCustom | null>;
};

export type ResolvedCustom = {
  id: string;
  target: string;
  expiresAt: number;
  userId: string;
  owner: boolean;
};

/**
 * Account-level writes a custom frontend's JS may not make, even with the
 * user's own cookies (docs/custom-frontend.md, "Not available"): minting an
 * API or CLI token (it would outlive the preview), registering more previews,
 * anything under /api/dev or /api/dev-access, and better-auth's account
 * changes (all but sign-out). Refused while the browser holds a custom live
 * cookie; any page without ?live clears it.
 */
export function customFrontendBlocked(method: string, p: string): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  const path = p.toLowerCase().replace(/\/+$/, "");
  if (/^\/api\/(dev|dev-access)(\/|$)/.test(path)) return true;
  if (/^\/api\/(token|cli-login|live-previews|live-view)(\/|$)/.test(path)) return true;
  if (/^\/api\/auth(\/|$)/.test(path)) return path !== "/api/auth/sign-out";
  return false;
}

/** The cheap first look: could this request be live at all? */
export function mayBeLive(url: string, cookie: string | null): boolean {
  return url.includes(`${LIVE_PARAM}=`) || (cookie ?? "").includes(`${LIVE_COOKIE}=`);
}

export type LiveKind = "document" | "rsc" | "asset" | "socket" | "other";

/** Production's own: never proxied, whatever the cookie or the parameter. */
export function isBackendPath(p: string): boolean {
  return /^\/(api|auth|_lk)(\/|$)/i.test(p);
}

/** What the dev page loads from its own server: Next's chunks, HMR, the dev overlay. */
export function isDevAssetPath(p: string): boolean {
  return p.startsWith("/_next/") || p.startsWith("/__nextjs");
}

export function requestKind(req: Request, url: URL): LiveKind {
  const p = url.pathname;
  if (isBackendPath(p)) return "other";
  const h = req.headers;
  if ((h.get("upgrade") ?? "").toLowerCase() === "websocket")
    return req.method === "GET" && isDevAssetPath(p) ? "socket" : "other";
  if (req.method !== "GET" && req.method !== "HEAD") return "other";
  if (isDevAssetPath(p)) return "asset";
  if (h.get("rsc") === "1") return "rsc";
  const dest = (h.get("sec-fetch-dest") ?? "").toLowerCase();
  if (dest) return dest === "document" ? "document" : "other";
  return /(^|,)\s*text\/html\s*(;|,|$)/i.test(h.get("accept") ?? "") ? "document" : "other";
}

/**
 * The upstream URL: the pointer's origin, with only the path and query set
 * (minus `live`). null for anything that could leave that origin or confuse
 * a parser on the way: `//`, a backslash, encoded slashes or NUL, control
 * characters, or `@` outside Next's own chunk paths.
 */
export function upstreamUrl(target: string, url: URL): URL | null {
  const p = url.pathname;
  if (!p.startsWith("/") || p.includes("//")) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]|%2f|%5c|%00/i.test(p)) return null;
  if (!p.startsWith("/_next/") && /@|%40/i.test(p)) return null;
  let t: URL;
  try {
    t = new URL(target);
  } catch {
    return null;
  }
  const up = new URL(t.origin);
  up.pathname = p;
  const q = new URLSearchParams(url.search);
  q.delete(LIVE_PARAM);
  const s = q.toString();
  up.search = s ? `?${s}` : "";
  return up.origin === t.origin && up.pathname === p ? up : null;
}

/** The request headers that may go up. Everything else (Cookie, Authorization, cf-*, …) never does. */
const FORWARD = [
  "accept",
  "accept-language",
  "user-agent",
  "rsc",
  "next-router-state-tree",
  "next-router-prefetch",
  "next-router-segment-prefetch",
  "next-url",
  "next-hmr-refresh",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "if-none-match",
  "if-modified-since",
  "range",
];
const FORWARD_WS = [
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-protocol",
  "sec-websocket-extensions",
];

/**
 * `secret`: the owner's gate secret (his pointer's page only); null for a
 * custom frontend, which gets nothing of ours.
 */
export function upstreamHeaders(req: Request, target: string, secret: string | null): Headers {
  const out = new Headers();
  const socket = (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
  for (const k of socket ? [...FORWARD, ...FORWARD_WS] : FORWARD) {
    const v = req.headers.get(k);
    if (v !== null) out.set(k, v);
  }
  out.set("origin", new URL(target).origin);
  if (secret !== null) out.set(LIVE_GATE_HEADER, secret);
  return out;
}

/**
 * A redirect from the dev page: relative, or to the tunnel's own origin →
 * the same path and query on lianki.com, still live; anywhere else unchanged.
 */
export function rewriteLocation(loc: string, target: string, id: string): string {
  const t = new URL(target).origin;
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(loc) || loc.startsWith("//");
  let u: URL;
  try {
    u = new URL(loc, `${t}/`);
  } catch {
    return loc;
  }
  if (absolute && u.origin !== t) return loc;
  u.searchParams.set(LIVE_PARAM, id);
  return `/${u.pathname.replace(/^\/+/, "")}${u.search}${u.hash}`;
}

const enc = new TextEncoder();
const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

async function mac(secret: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(`lk-live|${data}`))));
}

function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export type LiveCookie = { serial: number; until: number };

/** `<serial>.<until ms>.<hmac>`: the pointer it was set for, and when it lapses. */
export async function sealLiveCookie(secret: string, c: LiveCookie): Promise<string> {
  const body = `${c.serial}.${c.until}`;
  return `${body}.${await mac(secret, body)}`;
}

export async function openLiveCookie(
  secret: string,
  v: string | undefined,
  now: number,
): Promise<LiveCookie | null> {
  const m = /^(\d{1,16})\.(\d{1,16})\.([A-Za-z0-9_-]{43})$/.exec(v ?? "");
  if (!m) return null;
  if (!same(m[3], await mac(secret, `${m[1]}.${m[2]}`))) return null;
  const c = { serial: Number(m[1]), until: Number(m[2]) };
  return c.until > now ? c : null;
}

export function readCookie(header: string | null, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export const clearLiveCookie = () =>
  `${LIVE_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;

/** A JS string literal that is safe inside <script>: no "</script>", no line separators. */
const lit = (s: string) =>
  JSON.stringify(s)
    .replace(/</g, "\\u003c")
    .split(String.fromCharCode(0x2028))
    .join("\\u2028")
    .split(String.fromCharCode(0x2029))
    .join("\\u2029");

/**
 * A script that puts a small fixed element at the end of <body>, built with
 * the DOM (text only, never HTML), and puts it back whenever it goes: React's
 * hydration removes nodes it did not render (seen on lianki.com, 2026-11-05),
 * so a plain server-rendered <div> would vanish. One observer on <body>'s
 * own children; no timer.
 */
function mountScript(elId: string, css: string, text: string, href: string, link: string) {
  return `(function(){function m(){var b=document.body;if(!b||document.getElementById(${lit(elId)}))return;var d=document.createElement("div");d.id=${lit(elId)};d.setAttribute("role","status");d.style.cssText=${lit(css)};d.append(${lit(text)});var a=document.createElement("a");a.href=${lit(href)};a.textContent=${lit(link)};a.style.cssText="color:inherit;text-decoration:underline";d.append(a);b.appendChild(d)}
m();document.addEventListener("DOMContentLoaded",m);addEventListener("load",m);if(document.body&&typeof MutationObserver==="function")new MutationObserver(m).observe(document.body,{childList:true});})();`;
}

/** The URL with live=off: what the badge's "stop" opens. */
export function offHref(url: URL): string {
  const u = new URL(url);
  u.searchParams.set(LIVE_PARAM, "off");
  return `${u.pathname}${u.search}`;
}

/**
 * The badge (bottom-left, out of the chat widget's corner) and its script:
 * `?live=<id>` kept on history pushes and replaces and on same-origin link
 * clicks, and STORM_LOADS loads within STORM_WINDOW_MS (sessionStorage) go
 * to ?live=off.
 */
export function badgeHtml(id: string, label: string, off: string, nonce?: string): string {
  const css =
    "position:fixed;left:12px;bottom:12px;z-index:2147483647;display:flex;gap:6px;align-items:center;" +
    "padding:4px 10px;border-radius:999px;font:600 12px/1.6 system-ui,-apple-system,sans-serif;" +
    "background:oklch(0.55 0.2 25);color:oklch(0.99 0 0);box-shadow:0 2px 8px oklch(0 0 0 / 0.3)";
  const js = `(function(){var ID=${lit(id)},P=${lit(LIVE_PARAM)},N=${STORM_LOADS},W=${STORM_WINDOW_MS};
function off(){var u=new URL(location.href);u.searchParams.set(P,"off");return u.pathname+u.search+u.hash}
try{var k="lk:live-loads",t=Date.now(),a=JSON.parse(sessionStorage.getItem(k)||"[]").filter(function(x){return typeof x==="number"&&t-x<W});a.push(t);sessionStorage.setItem(k,JSON.stringify(a));if(a.length>=N){sessionStorage.removeItem(k);location.replace(off());return}}catch(e){}
function keep(v){if(v==null)return v;try{var u=new URL(String(v),location.href);if(u.origin!==location.origin||u.searchParams.has(P))return v;u.searchParams.set(P,ID);return u.pathname+u.search+u.hash}catch(e){return v}}
["pushState","replaceState"].forEach(function(m){var o=history[m];history[m]=function(s,t,u){return arguments.length>2?o.call(this,s,t,keep(u)):o.apply(this,arguments)}});
document.addEventListener("click",function(e){var a=e.target&&e.target.closest&&e.target.closest("a[href]");if(!a||(a.target&&a.target!=="_self"))return;var h=a.getAttribute("href"),n=keep(h);if(n!==h)a.setAttribute("href",n)},true);
})();`;
  // A custom frontend's CSP allows inline scripts with its nonce only (base64url: safe in an attribute).
  const n = nonce && /^[A-Za-z0-9_-]+$/.test(nonce) ? ` nonce="${nonce}"` : "";
  return `<script${n}>${js}${mountScript("lk-live-badge", css, `LIVE · ${label} · `, off, "stop")}</script>`;
}

/** The production page's notice when a live page could not be served. */
export function noticeHtml(why: string, off: string): string {
  const css =
    "position:fixed;left:12px;bottom:12px;z-index:2147483647;max-width:calc(100vw - 24px);" +
    "padding:6px 12px;border-radius:12px;font:500 13px/1.5 system-ui,-apple-system,sans-serif;" +
    "background:oklch(0.3 0.02 250);color:oklch(0.97 0.01 250);box-shadow:0 2px 8px oklch(0 0 0 / 0.3)";
  return `<script>${mountScript("lk-live-notice", css, `预览不可用，这是正式版 · Preview unavailable (${why}) · `, off, "关闭")}</script>`;
}

type RewriterElement = {
  append(s: string, o: { html: boolean }): void;
  setAttribute(name: string, value: string): void;
};
type Rewriter = {
  on(sel: string, h: { element(e: RewriterElement): void }): Rewriter;
  transform(r: Response): Response;
};

/** Append `html` to <body> of an HTML response (HTMLRewriter: Workers and Bun). */
export function appendToBody(res: Response, html: string): Response {
  const R = (globalThis as unknown as { HTMLRewriter?: new () => Rewriter }).HTMLRewriter;
  if (!R || !/text\/html/i.test(res.headers.get("content-type") ?? "")) return res;
  return new R()
    .on("body", {
      element(e) {
        e.append(html, { html: true });
      },
    })
    .transform(res);
}

/**
 * A custom frontend's document: `nonce` on every <script> of the proxied HTML
 * (the CSP allows inline scripts with it only), and `html` (the badge, which
 * carries the nonce itself) appended to <body>.
 */
export function nonceAndAppend(res: Response, nonce: string, html: string): Response {
  const R = (globalThis as unknown as { HTMLRewriter?: new () => Rewriter }).HTMLRewriter;
  if (!R || !/text\/html/i.test(res.headers.get("content-type") ?? "")) return res;
  return new R()
    .on("script", {
      element(e) {
        e.setAttribute("nonce", nonce);
      },
    })
    .on("body", {
      element(e) {
        e.append(html, { html: true });
      },
    })
    .transform(res);
}

/** The custom preview through the app itself: 200 for its registrant's session only. */
async function customByApi(req: Request, id: string, next: Next): Promise<ResolvedCustom | null> {
  const cookie = req.headers.get("cookie") ?? "";
  if (!sessionToken(cookie)) return null;
  try {
    const r = await next(
      new Request(new URL(`/api/live-previews/${id}`, req.url), { headers: { cookie } }),
    );
    if (r.status !== 200) return null;
    const b = (await r.json()) as Partial<ResolvedCustom>;
    if (b.id !== id || typeof b.target !== "string" || typeof b.userId !== "string") return null;
    if (typeof b.expiresAt !== "number") return null;
    return {
      id,
      target: b.target,
      expiresAt: b.expiresAt,
      userId: b.userId,
      owner: b.owner === true,
    };
  } catch {
    return null;
  }
}

/** Whoami through the app itself: 200 {owner:true} for the owner's session only. */
async function ownerByWhoami(req: Request, next: Next) {
  const cookie = req.headers.get("cookie") ?? "";
  if (!/better-auth\.session_token=/.test(cookie)) return false;
  try {
    const r = await next(new Request(new URL("/api/dev/whoami", req.url), { headers: { cookie } }));
    if (r.status !== 200) return false;
    return ((await r.json()) as { owner?: unknown }).owner === true;
  } catch {
    return false;
  }
}

export function createLivePage(d: LiveDeps) {
  const now = d.now ?? Date.now;
  const up = d.fetch ?? ((r: Request) => fetch(r));
  let keys: Promise<CryptoKey[]> | null = null;
  const trusted = () =>
    (keys ??= d.keys
      ? d.keys()
      : Promise.all(LIVE_VIEW_PUBLIC_KEYS.map((k) => importLiveViewPublicKey(k))));
  let cache: { at: number; v: LivePage | null } | null = null;

  /** The stored pointer, verified, if it names a page origin. Cached POINTER_CACHE_MS. */
  async function current(db: LiveDb | undefined): Promise<LivePage | null> {
    const t = now();
    if (cache && t - cache.at < POINTER_CACHE_MS) return cache.v;
    let v: LivePage | null = null;
    if (db) {
      try {
        const row = await db
          .prepare("SELECT pointer FROM live_view WHERE id = ?")
          .bind(1)
          .first<{ pointer: string | null }>();
        if (row?.pointer) {
          const r = await verifyLiveView(row.pointer, await trusted(), {
            op: "on",
            now: t,
            allowLocal: d.allowLocal,
          });
          if (r.ok && r.claim.page)
            v = {
              serial: r.claim.serial,
              page: r.claim.page,
              exp: r.claim.exp * 1000,
              label: liveLabel(r.claim),
            };
        }
      } catch {
        v = null; // no table, D1 down: not live
      }
    }
    cache = { at: t, v };
    return v;
  }

  /** Custom previews by id, re-read from D1 at most every POINTER_CACHE_MS. */
  const customCache = new Map<string, { at: number; v: CustomPreview | null }>();
  async function customActive(db: LiveDb | undefined, c: Parameters<typeof activeForCookie>[1]) {
    const t = now();
    const hit = customCache.get(c.id);
    if (hit && t - hit.at < POINTER_CACHE_MS)
      return hit.v && hit.v.userId === c.userId ? hit.v : null;
    let v: CustomPreview | null = null;
    if (db) {
      try {
        v = await activeForCookie(db, c, t);
      } catch {
        v = null; // no table, D1 down: not live
      }
    }
    if (customCache.size > 500) customCache.clear();
    customCache.set(c.id, { at: t, v });
    return v;
  }

  const mark = (h: Headers, id: string) => {
    h.set("cache-control", "no-store");
    h.set(LIVE_ID_HEADER, id);
    h.set("content-security-policy", "frame-ancestors 'self'");
    h.set("referrer-policy", "same-origin");
    h.delete("x-frame-options");
  };

  /** Production for this request, marked as a failed live attempt (owner only). */
  async function fallback(next: Next, req: Request, url: URL, why: string): Promise<Response> {
    const r = await next(req);
    const res = new Response(r.body, r);
    res.headers.set("cache-control", "no-store");
    res.headers.append("set-cookie", clearLiveCookie());
    res.headers.delete("content-length");
    return appendToBody(res, noticeHtml(why, offHref(url)));
  }

  function redirect(to: string, cookie: string): Response {
    return new Response(null, {
      status: 303,
      headers: { location: to, "cache-control": "no-store", "set-cookie": cookie },
    });
  }

  async function proxied(
    req: Request,
    upUrl: URL,
    p: LivePage,
    secret: string,
    timeoutMs: number,
  ): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      return await up(
        new Request(upUrl.href, {
          method: req.method,
          headers: upstreamHeaders(req, p.page, secret),
          redirect: "manual",
          signal: ctl.signal,
        }),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function proxiedCustom(
    req: Request,
    upUrl: URL,
    target: string,
    timeoutMs: number,
  ): Promise<Response> {
    // The upstream origin, asserted once more right before the fetch.
    if (upUrl.origin !== target) throw new Error("upstream origin");
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      return await up(
        new Request(upUrl.href, {
          method: req.method,
          headers: upstreamHeaders(req, target, null),
          redirect: "manual",
          signal: ctl.signal,
        }),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** A custom frontend's response: filtered, marked, with the strict CSP. */
  function downCustom(
    r: Response,
    target: string,
    id: string,
    site: string,
    nonce?: string,
    extra?: (h: Headers) => void,
  ): Response {
    const h = filterTunnelFetchHeaders(r.headers);
    const loc = h.get("location");
    if (loc) h.set("location", rewriteLocation(loc, target, id));
    mark(h, id);
    h.set("content-security-policy", customCsp(target, site, nonce));
    extra?.(h);
    if (r.status === 101) {
      if (!d.respond101) return new Response("websocket unavailable", { status: 502 });
      return d.respond101(r, h);
    }
    return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
  }

  /** `?live=<custom id>` on a document: its registrant only. */
  async function customDocument(
    req: Request,
    url: URL,
    id: string,
    secret: string,
    enabled: boolean,
    next: Next,
  ): Promise<Response> {
    const resolve = d.resolveCustom ?? ((r: Request, i: string) => customByApi(r, i, next));
    const token = sessionToken(req.headers.get("cookie"));
    const p = enabled && token ? await resolve(req, id) : null;
    const target = p ? customTarget(p.target) : null;
    if (!p || !token || !target || target !== p.target || p.expiresAt <= now()) {
      // Not theirs, or not live: the normal page, as anyone gets it, and
      // live mode left.
      const r = await next(req);
      const res = new Response(r.body, r);
      res.headers.append("set-cookie", clearLiveCookie());
      return res;
    }
    const upUrl = upstreamUrl(target, url);
    if (!upUrl) return fallback(next, req, url, "path refused");
    let r: Response;
    try {
      r = await proxiedCustom(req, upUrl, target, DOC_TIMEOUT_MS);
    } catch {
      return fallback(next, req, url, "dev server unreachable");
    }
    if (r.status >= 500) {
      void r.body?.cancel().catch(() => {});
      return fallback(next, req, url, `dev server ${r.status}`);
    }
    const until = Math.min(now() + LIVE_IDLE_MS, p.expiresAt);
    const sealed = await sealCustomCookie(secret, {
      id,
      userId: p.userId,
      until,
      owner: p.owner,
      session: await sessionTag(token),
    });
    const cookie = `${LIVE_COOKIE}=${sealed}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.max(1, Math.floor((until - now()) / 1000))}`;
    const nonce = cspNonce();
    const res = downCustom(r, target, id, url.origin, nonce, (h) => {
      h.append("set-cookie", cookie);
      h.delete("content-length");
    });
    return nonceAndAppend(res, nonce, badgeHtml(id, new URL(target).host, offHref(url), nonce));
  }

  /** A custom frontend's subresource: the sealed cookie, its session, and D1 agree. */
  async function customSubresource(
    req: Request,
    url: URL,
    kind: LiveKind,
    raw: string,
    secret: string,
    env: LiveEnv,
    next: Next,
  ): Promise<Response> {
    const c = await openCustomCookie(secret, raw, now());
    if (!c) return next(req);
    const token = sessionToken(req.headers.get("cookie"));
    if (!token || (await sessionTag(token)) !== c.session) return next(req);
    if (kind === "rsc") {
      let ref: URL | null = null;
      try {
        ref = new URL(req.headers.get("referer") ?? "");
      } catch {}
      if (!ref || ref.origin !== url.origin || ref.searchParams.get(LIVE_PARAM) !== c.id)
        return next(req);
    }
    const p = await customActive(env.DB, c);
    const target = p ? customTarget(p.target) : null;
    if (!p || !target) return next(req);
    if (isServiceWorkerScript(url.pathname, req.headers.get("service-worker")))
      return new Response("no service workers from a custom frontend\n", {
        status: 403,
        headers: { "cache-control": "no-store" },
      });
    const upUrl = upstreamUrl(target, url);
    if (!upUrl)
      return new Response("path refused\n", {
        status: 400,
        headers: { "cache-control": "no-store" },
      });
    try {
      return downCustom(
        await proxiedCustom(req, upUrl, target, ASSET_TIMEOUT_MS),
        target,
        c.id,
        url.origin,
      );
    } catch {
      return new Response("dev server unreachable\n", {
        status: 504,
        headers: { "cache-control": "no-store", [LIVE_ID_HEADER]: c.id },
      });
    }
  }

  function down(r: Response, p: LivePage, extra?: (h: Headers) => void): Response {
    const id = String(p.serial);
    const h = filterTunnelFetchHeaders(r.headers);
    const loc = h.get("location");
    if (loc) h.set("location", rewriteLocation(loc, p.page, id));
    mark(h, id);
    extra?.(h);
    if (r.status === 101) {
      if (!d.respond101) return new Response("websocket unavailable", { status: 502 });
      return d.respond101(r, h);
    }
    return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
  }

  return {
    current,
    /** `next`: production for this request (OpenNext, with this request's env and ctx). */
    async handle(req: Request, env: LiveEnv, next: Next): Promise<Response> {
      const isOwner = d.isOwner ?? ((r: Request) => ownerByWhoami(r, next));
      if (!mayBeLive(req.url, req.headers.get("cookie"))) return next(req);
      const url = new URL(req.url);
      // A custom frontend's JS may not make account-level writes (above).
      if (
        readCookie(req.headers.get("cookie"), LIVE_COOKIE)?.startsWith("c.") &&
        customFrontendBlocked(req.method, url.pathname)
      )
        return new Response(
          JSON.stringify({
            error: "Not available from a custom frontend; open lianki.com without ?live",
          }),
          {
            status: 403,
            headers: { "content-type": "application/json", "cache-control": "no-store" },
          },
        );
      const kind = requestKind(req, url);
      if (kind === "other") return next(req);
      const secret = env.LIVE_GATE_SECRET ?? "";
      const enabled = secret.length >= LIVE_SECRET_MIN;
      const raw = readCookie(req.headers.get("cookie"), LIVE_COOKIE);
      const param = url.searchParams.get(LIVE_PARAM);

      if (kind === "document") {
        if (param === null) {
          // A document without ?live leaves live mode.
          const r = await next(req);
          if (raw === undefined) return r;
          const res = new Response(r.body, r);
          res.headers.append("set-cookie", clearLiveCookie());
          return res;
        }
        // A custom frontend's id: its registrant only (docs/custom-frontend.md).
        if (isCustomId(param)) return customDocument(req, url, param, secret, enabled, next);
        // Leaving a custom frontend: anyone may clear their own cookie.
        if (param === "off" && raw?.startsWith("c.")) {
          const u = new URL(url);
          u.searchParams.delete(LIVE_PARAM);
          return redirect(`${u.pathname}${u.search}`, clearLiveCookie());
        }
        // Only the owner ever sees a difference; everyone else gets the normal page, untouched.
        if (!(await isOwner(req))) return next(req);
        if (param === "off") {
          const u = new URL(url);
          u.searchParams.delete(LIVE_PARAM);
          return redirect(`${u.pathname}${u.search}`, clearLiveCookie());
        }
        if (!enabled) return fallback(next, req, url, "not set up");
        const p = await current(env.DB);
        if (p && param === "on") {
          const u = new URL(url);
          u.searchParams.set(LIVE_PARAM, String(p.serial));
          return redirect(`${u.pathname}${u.search}`, clearLiveCookie());
        }
        if (!p || String(p.serial) !== param) return fallback(next, req, url, "no such preview");
        const upUrl = upstreamUrl(p.page, url);
        if (!upUrl) return fallback(next, req, url, "path refused");
        let r: Response;
        try {
          r = await proxied(req, upUrl, p, secret, DOC_TIMEOUT_MS);
        } catch {
          return fallback(next, req, url, "dev server unreachable");
        }
        if (r.status >= 500) {
          void r.body?.cancel().catch(() => {});
          return fallback(next, req, url, `dev server ${r.status}`);
        }
        const until = Math.min(now() + LIVE_IDLE_MS, p.exp);
        const cookie = `${LIVE_COOKIE}=${await sealLiveCookie(secret, { serial: p.serial, until })}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.max(1, Math.floor((until - now()) / 1000))}`;
        const res = down(r, p, (h) => {
          h.append("set-cookie", cookie);
          h.delete("content-length");
        });
        return appendToBody(res, badgeHtml(String(p.serial), p.label, offHref(url)));
      }

      // Subresources: the cookie, still matching the stored pointer.
      if (!enabled || raw === undefined) return next(req);
      if (raw.startsWith("c.")) return customSubresource(req, url, kind, raw, secret, env, next);
      const c = await openLiveCookie(secret, raw, now());
      if (!c) return next(req);
      if (kind === "rsc") {
        // The router's fetch from a live page: its Referer still says so.
        let ref: URL | null = null;
        try {
          ref = new URL(req.headers.get("referer") ?? "");
        } catch {}
        if (
          !ref ||
          ref.origin !== url.origin ||
          ref.searchParams.get(LIVE_PARAM) !== String(c.serial)
        )
          return next(req);
      }
      const p = await current(env.DB);
      if (!p || p.serial !== c.serial) return next(req);
      if (isServiceWorkerScript(url.pathname, req.headers.get("service-worker")))
        return new Response("no service workers from the dev server\n", {
          status: 403,
          headers: { "cache-control": "no-store" },
        });
      const upUrl = upstreamUrl(p.page, url);
      if (!upUrl)
        return new Response("path refused\n", {
          status: 400,
          headers: { "cache-control": "no-store" },
        });
      try {
        return down(await proxied(req, upUrl, p, secret, ASSET_TIMEOUT_MS), p);
      } catch {
        // The router does a full load on a failed RSC fetch: that page, without ?live, is production.
        return new Response("dev server unreachable\n", {
          status: 504,
          headers: { "cache-control": "no-store", [LIVE_ID_HEADER]: String(p.serial) },
        });
      }
    },
  };
}
