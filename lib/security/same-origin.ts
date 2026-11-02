/**
 * CSRF guard for owner-only state changes (/api/dev/flags). The /dev admin
 * actions are same-origin `fetch` POSTs with a JSON body, and the session
 * cookie is SameSite=Lax, so a cross-site form cannot carry it. This makes the
 * rule explicit instead of resting on the cookie alone:
 *
 * - `Content-Type: application/json` — a cross-site HTML form cannot send it,
 *   and a cross-site `fetch` with it needs a CORS preflight we never answer;
 * - `Origin` present and naming this host (browsers always send it on a POST);
 * - `Sec-Fetch-Site`, when the browser sends it, is `same-origin`.
 *
 * Any miss is refused before the handler reads the body.
 */
export function sameOriginJsonPost(req: Request): boolean {
  if (req.method !== "POST") return false;
  const type = req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") return false;
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;
  const origin = req.headers.get("origin");
  const host = req.headers.get("host") ?? new URL(req.url).host;
  if (!origin || !host) return false;
  try {
    const o = new URL(origin);
    // Plain http only on a local dev server.
    const local = o.hostname === "localhost" || o.hostname === "127.0.0.1";
    return (o.protocol === "https:" || (local && o.protocol === "http:")) && o.host === host;
  } catch {
    return false;
  }
}
