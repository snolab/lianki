/**
 * What a response from the owner's dev tunnel may never carry, wherever it is
 * served: on preview.lianki.com (the gate, scripts/dev/preview-gate.ts) and on
 * lianki.com itself (the same-origin live preview, lib/live-view/page-proxy.ts).
 * Dev code may render the page, but it may not change the browser's state for
 * the origin: no cookies, no wiping site data, no policy of its own (CSP,
 * CORS, HSTS) and no service worker scope. Pure and isomorphic: the gate
 * (Bun), the Worker and the tests share it. docs/live-view.md, "Same-origin
 * pages".
 */

/** Dropped by name (lower case). */
export const TUNNEL_DROP: ReadonlySet<string> = new Set([
  "set-cookie",
  "set-cookie2",
  "clear-site-data",
  "content-security-policy",
  "content-security-policy-report-only",
  "strict-transport-security",
  "service-worker-allowed",
]);

/** Dropped by prefix: every CORS response header. */
const DROP_PREFIXES = ["access-control-"];

export function tunnelHeaderDropped(name: string): boolean {
  const k = name.trim().toLowerCase();
  return TUNNEL_DROP.has(k) || DROP_PREFIXES.some((p) => k.startsWith(p));
}

export type HeaderBag = Record<string, string | string[] | undefined>;

/** A copy of `h` without the headers a tunnel response may never carry. */
export function filterTunnelHeaders(h: HeaderBag): HeaderBag {
  const out: HeaderBag = {};
  for (const [k, v] of Object.entries(h)) if (!tunnelHeaderDropped(k)) out[k] = v;
  return out;
}

/** The same filter on a fetch `Headers` (the Worker), as a new object. */
export function filterTunnelFetchHeaders(h: Headers): Headers {
  const out = new Headers();
  h.forEach((v, k) => {
    if (!tunnelHeaderDropped(k)) out.append(k, v);
  });
  return out;
}

/**
 * A service worker script request: the browser marks the fetch of a script
 * being registered (and its update checks) with `Service-Worker: script`, and
 * the app's own worker is /sw.js. A service worker from dev code would
 * outlive the preview and control every later page of the origin, so the
 * tunnel never serves one: 403.
 */
export function isServiceWorkerScript(
  pathname: string,
  serviceWorkerHeader: string | null | undefined,
): boolean {
  if ((serviceWorkerHeader ?? "").trim().toLowerCase() === "script") return true;
  const last = (pathname.split("/").pop() ?? "").toLowerCase();
  return /(^|[-_.])sw\.js$/.test(last) || /service-?worker\.js$/.test(last);
}
