import { childApi } from "@/lib/api-token-child";
import { isDevUser, type BoxDb } from "@/lib/box-oauth/store";
import { loadConfig } from "@/lib/config-store";
import { defaultConfig } from "@/lib/config";
import { dbBackend, getD1 } from "@/lib/d1";
import type { D1Like } from "@/lib/d1/types";
import { flagOn } from "@/lib/flags-store";
import { notifyTokensRevoked } from "@/lib/push-chat-tokens";
import type { AuditDb } from "@/lib/security/audit-log";

export const dynamic = "force-dynamic";

/**
 * A lane token's own child tokens (lib/api-token-child.ts): mint, list,
 * revoke. Bearer only (the parent token), never a browser session. Behind the
 * flag tokens.child (off: 404). D1 only.
 */
async function handle(req: Request) {
  if (dbBackend() !== "d1") return Response.json({ error: "not-available" }, { status: 503 });
  const db = () => getD1() as unknown as D1Like & AuditDb;
  return childApi(req, {
    db,
    enabled: () => flagOn("tokens.child"),
    siteOwner: (userId) => isDevUser(getD1() as unknown as BoxDb, userId).catch(() => false),
    limits: async () => {
      const c = await loadConfig(db()).catch(defaultConfig);
      return {
        defaultMinutes: c["tokens.childDefaultMinutes"],
        maxMinutes: c["tokens.childMaxMinutes"],
        maxLive: c["tokens.childMaxLive"],
      };
    },
    revoked: (ids) => notifyTokensRevoked({ ids }),
  });
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
