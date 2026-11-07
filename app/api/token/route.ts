import { authUserOrNull } from "@/app/signInEmail";
import { tokenApi } from "@/lib/api-token-api";
import { isSiteOwnerUser, type BoxDb } from "@/lib/box-oauth/store";
import { dbBackend, getD1 } from "@/lib/d1";
import type { D1Like } from "@/lib/d1/types";
import { notifyTokensRevoked } from "@/lib/push-chat-tokens";
import type { AuditDb } from "@/lib/security/audit-log";

export const dynamic = "force-dynamic";

/**
 * The signed-in account's API tokens: list, make (name, permissions, expiry),
 * revoke (lib/api-token-api.ts, lib/api-tokens.ts). D1 only: on the frozen
 * Mongo rollback copy no token is made or listed.
 */
async function handle(req: Request) {
  if (dbBackend() !== "d1") return Response.json({ error: "Not available" }, { status: 503 });
  return tokenApi(req, {
    who: async () => {
      const u = await authUserOrNull();
      return u?.id && u.email ? { userId: u.id, email: u.email } : null;
    },
    db: () => getD1() as unknown as D1Like & AuditDb,
    // The `eval` permission (lib/api-tokens.ts OWNER_SCOPES): site_role, read now.
    siteOwner: (userId) => isSiteOwnerUser(getD1() as unknown as BoxDb, userId).catch(() => false),
    revoked: (ids) => notifyTokensRevoked({ ids }),
  });
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
