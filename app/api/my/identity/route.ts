import { isDevUser, type BoxDb } from "@/lib/box-oauth/store";
import { dbBackend, getD1 } from "@/lib/d1";
import type { D1Like } from "@/lib/d1/types";
import { flagIn } from "@/lib/flags";
import { readFlags } from "@/lib/flags-store";
import { identityApi } from "@/lib/identity-api";
import type { AuditDb } from "@/lib/security/audit-log";

export const dynamic = "force-dynamic";

async function handle(req: Request) {
  if (dbBackend() !== "d1") return Response.json({ error: "not-available" }, { status: 503 });
  const db = getD1() as unknown as D1Like & AuditDb;
  return identityApi(req, {
    db: () => db,
    allowed: async (userId) =>
      flagIn(await readFlags(), "chat.agent-identities") &&
      (await isDevUser(db as unknown as BoxDb, userId).catch(() => false)),
  });
}

export const GET = handle;
export const POST = handle;
