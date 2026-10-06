import { createAuthMiddleware } from "better-auth/api";

/**
 * Drop `include_granted_scopes` from a Google authorization URL.
 *
 * better-auth's Google provider hardcodes `include_granted_scopes=true`, which
 * tells Google to fold every scope the user ever granted to *any* client in the
 * same GCP project into this request. Lianki's OAuth client shares a project
 * with Drive/YouTube tools, so an account that once granted those got
 * `invalid_request: This request contains scopes that cannot be requested
 * together` — sign-in failed with the redirect URI otherwise accepted. Lianki
 * only ever needs `openid email profile`, so incremental auth buys nothing.
 */
/** better-auth `hooks.after`: rewrites `/sign-in/social`'s `{ url }` in place. */
export const stripGrantedScopesHook = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== "/sign-in/social") return;
  const ret = ctx.context.returned as { url?: string } | undefined;
  if (ret && typeof ret.url === "string") ret.url = withoutGrantedScopes(ret.url);
});

export function withoutGrantedScopes(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname !== "accounts.google.com") return url;
    u.searchParams.delete("include_granted_scopes");
    return u.toString();
  } catch {
    return url;
  }
}
