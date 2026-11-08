/**
 * Where a box's /sign-in sends a signed-in tab back to (docs/box-oauth.md,
 * "The box's server sees the sign-in"). Pure: the middleware, the server's
 * redirect and the page all use it.
 */

/** The page's path and query, set by the middleware on a box's app routes; never by the request. */
export const BOX_PATH_HEADER = "x-lk-box-path";

/** A path on this host to return to, or null: never another host, never /sign-in itself. */
export function boxReturnPath(v: string | null | undefined): string | null {
  if (!v || v.length > 2048) return null;
  if (!v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\")) return null;
  // Control characters and backslashes: a browser may read them as another host.
  if (/[\u0000-\u001f\u007f\\]/.test(v)) return null;
  let u: URL;
  try {
    u = new URL(v, "https://box.invalid");
  } catch {
    return null;
  }
  if (u.origin !== "https://box.invalid") return null;
  if (u.pathname === "/sign-in" || u.pathname.startsWith("/sign-in/")) return null;
  return `${u.pathname}${u.search}`;
}
