import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { revokeAllTokens } from "@/lib/api-tokens";
import type { D1Like } from "@/lib/d1/types";
import { type AuditDb, audit } from "@/lib/security/audit-log";

/**
 * An account's API tokens die with a sign-out everywhere (better-auth's
 * `/revoke-sessions`) and with the account (`/delete-user`, if it is ever
 * turned on): every token of that account is deleted, the deletion is in the
 * security audit log, and lianki-push closes their listening sockets
 * (lib/api-tokens.ts, "One account"). A deleted account's tokens are refused
 * anyway: each use joins the live `user` row.
 *
 * Never fails the sign-out: an error is logged.
 */
export const ALL_SESSIONS_PATHS = new Set([
  "/revoke-sessions",
  "/delete-user",
  "/delete-user/callback",
]);

export function apiTokenSignOutPlugin(env: {
  getDb: () => (D1Like & AuditDb) | null;
  revoked: (r: { ids: string[]; userId: string }) => Promise<void>;
}): BetterAuthPlugin {
  return {
    id: "lianki-api-token-signout",
    hooks: {
      after: [
        {
          matcher: (ctx) => ALL_SESSIONS_PATHS.has(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const user = ctx.context.session?.user as { id?: string; email?: string } | undefined;
            const returned = ctx.context.returned as
              | { status?: unknown; success?: unknown }
              | undefined;
            if (!user?.id || !user.email || returned instanceof Error) return;
            const db = env.getDb();
            if (!db) return;
            try {
              const ids = await revokeAllTokens(db, { userId: user.id, email: user.email });
              await audit(db, {
                kind: "api-token.revoke-all",
                actor: user.id,
                detail: `${ids.length} token(s), ${ctx.path}`,
              });
              await env.revoked({ ids, userId: user.id });
            } catch (e) {
              console.error("[api-tokens] revoke all:", String(e).slice(0, 200));
            }
          }),
        },
      ],
    },
  };
}
