/**
 * Where a mini app runs (docs/mini-apps.md, "Isolation"): never lianki.com's
 * own origin. With config miniApps.origin set, the app is a real page on that
 * origin (`https://m.lianki.com`, or one per app: `https://{app}.<domain>`),
 * served by /api/m/<slug> with a signed ticket; empty, the host page embeds it
 * as `srcdoc` in the sandbox (an opaque origin). Pure.
 */

/** The app's origin under `template`, or null (no template, or not a valid one). */
export function appOrigin(template: string, appId: string): string | null {
  if (!template || !/^[0-9a-f]{16}$/.test(appId)) return null;
  try {
    const u = new URL(template.replace("{app}", appId));
    const local = /(^|\.)m\.localhost$/.test(u.hostname);
    if (u.protocol !== "https:" && !(local && u.protocol === "http:")) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** The last two labels: lianki.com, liankiapps.com; localhost for every *.localhost. */
export function siteOf(host: string): string {
  const h = host.replace(/:\d+$/, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return "localhost";
  return h.split(".").slice(-2).join(".");
}

/**
 * May the iframe keep its own origin (allow-same-origin)? Only one app per
 * origin, on another site than the host page: a sibling of lianki.com could
 * set cookies for lianki.com (docs/security-measures.md, "Sibling hosts").
 */
export function ownOriginAllowed(template: string, origin: string | null, hostOrigin: string) {
  if (!origin || !template.includes("{app}")) return false;
  return siteOf(new URL(origin).host) !== siteOf(new URL(hostOrigin).host);
}

/**
 * A host that serves only mini apps (m.lianki.com, <app>.m.lianki.com, and
 * m.localhost for local tests): middleware.ts lets through only the app
 * route and the public /m/ files there, nothing of Lianki's own pages.
 */
export function isMiniHost(host: string | null): boolean {
  return !!host && /^(?:[a-z0-9-]+\.)?m\.(?:lianki\.com|localhost)(?::\d{2,5})?$/i.test(host);
}

/** What a mini host may serve: the app route and the static /m/ files. */
export function miniHostPath(pathname: string): boolean {
  return (
    /^\/api\/m\/[a-z0-9-]{1,40}$/.test(pathname) ||
    /^\/m\/(?:sdk\.js|presets\/[A-Za-z0-9._-]+)$/.test(pathname)
  );
}

/** The host page's origin from its request headers: https, except a local dev host. */
export function pageOrigin(host: string | null, proto: string | null): string {
  const h = host && /^[A-Za-z0-9.-]+(?::\d{2,5})?$/.test(host) ? host : "lianki.com";
  const local = /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(h);
  return `${local && proto !== "https" ? "http" : "https"}://${h}`;
}
