/**
 * A browser treats every *.lianki.com host as the same site as lianki.com, so
 * a page on a sibling (a friend's devbox-<name>, a dev tunnel) sends the
 * SameSite=Lax session cookie with its POSTs here. The response can't be read
 * without CORS, but the write would already be done, and most routes take JSON
 * without asking for its Content-Type. Nothing of ours writes to the API from a
 * sibling host, so worker.ts refuses it before any route runs.
 *
 * Only a cookie-carrying browser request says `same-site`: webhooks, API tokens,
 * the CLI and the userscript's privileged requests never do. Kept free of
 * imports: this runs on the Worker's entry path for every request.
 */
export function siblingApiWrite(req: Request): boolean {
  if (req.headers.get("sec-fetch-site")?.toLowerCase() !== "same-site") return false;
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return false;
  if (!req.headers.get("cookie")) return false;
  return /^\/api(\/|$)/i.test(new URL(req.url).pathname);
}
