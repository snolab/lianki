/** An uploaded avatar's address (lib/profile/avatar.ts avatarPath), and nothing else. */
const AVATAR_READ = /^\/api\/avatar\/[A-Za-z0-9_-]{1,64}\/[0-9a-f]{20}$/;
/** A mini app's file (docs/mini-apps.md): a signed ticket in the query, no session, no write. */
const MINI_APP_READ = /^\/api\/m\/[a-z0-9-]{1,40}$/;

/**
 * A browser counts every *.lianki.com host as the same site as lianki.com, so
 * a page on a sibling (a user's box, a dev tunnel) gets the SameSite=Lax session
 * cookie sent with its requests here. It can't read the answers without CORS,
 * but the write would already be done, and most routes take JSON without asking
 * for its Content-Type. docs/security-measures.md, section 11.
 *
 * Nothing of ours needs this: the app calls /api from its own origin, and the
 * preview gate calls it from a server, with no cookie. So worker.ts refuses,
 * before any route runs, a cookie-carrying browser request marked
 * `Sec-Fetch-Site: same-site` that is:
 *
 * - to /api, whatever the method: several GETs write (/api/fsrs/review,
 *   /api/fsrs/delete, /api/fsrs/repeat, /api/invite);
 * - a write to any other path: server actions POST to page URLs.
 *
 * One exception: reading an uploaded avatar (`GET /api/avatar/<user>/<id>`,
 * exactly that shape). The route takes no session and writes nothing, and a
 * box's chat shows lianki.com avatars as plain <img>, which a browser sends with
 * the cookie: refused, every picture there fell back to an initial (2026-11-09).
 *
 * A second: a mini app's file (`GET /api/m/<slug>`), loaded by its iframe from
 * the apps' own host (m.lianki.com, a sibling). It reads only the signed
 * ticket in its query, never the session, and writes nothing.
 *
 * Reading a page or following a link from a sibling still works. Webhooks, API
 * tokens, the CLI and the userscript's requests never say `same-site`. A browser
 * that sends no Fetch Metadata passes. Kept free of imports: this runs on the
 * Worker's entry path for every request.
 */
export function siblingRequestRefused(req: Request): boolean {
  if (req.headers.get("sec-fetch-site")?.toLowerCase() !== "same-site") return false;
  if (!req.headers.get("cookie")) return false;
  const path = new URL(req.url).pathname;
  if (
    (req.method === "GET" || req.method === "HEAD") &&
    (AVATAR_READ.test(path) || MINI_APP_READ.test(path))
  )
    return false;
  if (/^\/api(\/|$)/i.test(path)) return true;
  return req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
}
