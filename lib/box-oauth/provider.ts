/**
 * lianki.com as the OAuth provider for my-<hash> boxes (docs/box-oauth.md),
 * using better-auth's own plugin. Only loaded with auth-impl.
 *
 * What the plugin brings: authorization code with PKCE, one-time codes, hashed
 * opaque tokens, refresh rotation, revocation. What it has no notion of, added
 * here: a client belongs to exactly one account. The hook refuses any other
 * account at /oauth2/authorize, and any unbound client at /oauth2/token; the
 * Worker's gate checks the same binding again on every API call. Authorize also
 * answers only a first-party navigation (rules.ts, isFirstPartyNavigation).
 */
import { oauthProvider } from "@better-auth/oauth-provider";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { getD1 } from "@/lib/d1";
import { isOwner } from "@/lib/owner";
import {
  ACCESS_TOKEN_SECONDS,
  isFirstPartyNavigation,
  BOX_SCOPES,
  BOX_TOKEN_PREFIX,
  CODE_SECONDS,
  REFRESH_TOKEN_SECONDS,
} from "./rules";
import { bindingByClient, type BoxDb } from "./store";

export function boxProviderPlugin() {
  return oauthProvider({
    // Never reached in the normal flow: /box-authorize signs the user in
    // first, and every box client skips consent (the owner's binding is the grant).
    // That holds only while the owner alone can bind a box to an account: opening
    // binding to members means revisiting this and adding a consent screen.
    loginPage: "/sign-in",
    consentPage: "/sign-in",
    disableJwtPlugin: true,
    scopes: [...BOX_SCOPES],
    grantTypes: ["authorization_code", "refresh_token"],
    codeExpiresIn: CODE_SECONDS,
    accessTokenExpiresIn: ACCESS_TOKEN_SECONDS,
    refreshTokenExpiresIn: REFRESH_TOKEN_SECONDS,
    prefix: { opaqueAccessToken: BOX_TOKEN_PREFIX, refreshToken: "lkr_" },
    // Exact match, for every client: no loopback port leniency.
    validateRedirectUri: (uri, registered) => registered.includes(uri),
    allowDynamicClientRegistration: false,
    allowUnauthenticatedClientRegistration: false,
    // Clients are made only by /api/dev/box-clients, as the owner. Every client
    // route over HTTP is shut anyway (app/api/auth/[...all]/route.ts).
    clientPrivileges: ({ action, user }: { action: string; user?: { email?: string | null } }) =>
      action === "create" && isOwner(user?.email),
    silenceWarnings: { oauthAuthServerConfig: true, openidConfig: true },
  } as Parameters<typeof oauthProvider>[0]);
}

/** Refuses at the provider, on the server, before the plugin runs. */
export const boxBindingHook = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== "/oauth2/authorize" && ctx.path !== "/oauth2/token") return;
  const db = getD1() as unknown as BoxDb;
  if (ctx.path === "/oauth2/token") {
    const id = (ctx.body as { client_id?: unknown } | undefined)?.client_id;
    const live = typeof id === "string" ? await bindingByClient(db, id) : null;
    if (!live) throw new APIError("BAD_REQUEST", { error: "invalid_client" });
    return;
  }
  // Only lianki.com's own entry page may start this: the answer holds a code.
  if (!ctx.headers || !isFirstPartyNavigation(ctx.headers))
    throw new APIError("FORBIDDEN", { error: "access_denied" });
  const id = ctx.query?.client_id;
  const live = typeof id === "string" ? await bindingByClient(db, id) : null;
  if (!live) throw new APIError("FORBIDDEN", { error: "invalid_client" });
  // Signed out: the plugin sends them to the login page, and they come back here.
  const session = await getSessionFromCtx(ctx);
  if (session && session.user.id !== live.userId)
    throw new APIError("FORBIDDEN", { error: "access_denied" });
});
