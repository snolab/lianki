import { authUserOrNull } from "@/app/signInEmail";
import { tokenScopeApi } from "@/lib/api-token-scopes";
import { isDevUser, type BoxDb } from "@/lib/box-oauth/store";
import { dbBackend, getD1 } from "@/lib/d1";
import type { D1Like } from "@/lib/d1/types";
import type { AuditDb } from "@/lib/security/audit-log";

export const dynamic = "force-dynamic";

/** A browser session approves one additional scope on its own live token. Never bearer-authenticated. */
async function handle(req: Request) {
  if (dbBackend() !== "d1") return Response.json({ error: "Not available" }, { status: 503 });
  return tokenScopeApi(req, {
    who: async () => {
      const user = await authUserOrNull();
      return user?.id && user.email ? { userId: user.id, email: user.email } : null;
    },
    db: () => getD1() as unknown as D1Like & AuditDb,
    siteOwner: (userId) => isDevUser(getD1() as unknown as BoxDb, userId).catch(() => false),
    revoked: async () => {},
  });
}
export const GET = handle;
export const POST = handle;
