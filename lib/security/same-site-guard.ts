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
 * Reading a page or following a link from a sibling still works. Webhooks, API
 * tokens, the CLI and the userscript's requests never say `same-site`. A browser
 * that sends no Fetch Metadata passes. Kept free of imports: this runs on the
 * Worker's entry path for every request.
 */
export function siblingRequestRefused(req: Request): boolean {
  if (req.headers.get("sec-fetch-site")?.toLowerCase() !== "same-site") return false;
  if (!req.headers.get("cookie")) return false;
  if (/^\/api(\/|$)/i.test(new URL(req.url).pathname)) return true;
  return req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
}
