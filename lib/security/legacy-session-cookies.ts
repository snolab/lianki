/**
 * Clearing what the session cookie used to be called (docs/secrets-and-auth.md,
 * "The session cookie"). Until the move to `__Host-`, better-auth's cookies were
 * `__Secure-better-auth.*`. Nothing reads those any more, so they only sit in the
 * browser: this sends each one back expired, once, on the next response. A browser
 * without them costs one string check. Free of imports: it is on the Worker's entry
 * path for every request.
 */
const NAME = /(?:^|;\s*)(__Secure-better-auth\.[A-Za-z0-9_.-]+)=/g;

export function legacyCookieNames(cookie: string | null | undefined): string[] {
  if (!cookie || !cookie.includes("__Secure-better-auth.")) return [];
  return [...cookie.matchAll(NAME)].map((m) => m[1]);
}

export function clearLegacyCookies(res: Response, names: string[]): Response {
  // A 101 cannot be rebuilt, and the socket's page load clears them anyway.
  if (names.length === 0 || res.status === 101) return res;
  const out = new Response(res.body, res);
  for (const name of names)
    out.headers.append("set-cookie", `${name}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`);
  return out;
}
