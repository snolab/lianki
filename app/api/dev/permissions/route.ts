import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend, getD1 } from "@/lib/d1";
import { isAdmin } from "@/lib/permissions";
import type { PermissionDb } from "@/lib/account-permission";
import { permissionsGet, permissionsPost } from "@/lib/permission-route";

/**
 * Who holds `admin` and `dev` (account_permission, lib/account-permission.ts).
 * Admin-only, 404 for anyone else, as every /api/dev route. GET lists the active
 * grants; POST `{op: "grant"|"revoke", email, permission}` (same-origin JSON
 * only) changes one, by exact address, and audits it. A revocation reaches every
 * isolate within PERMISSION_CACHE_MS (30 s), no deploy.
 */
async function admin() {
  const user = await authUserOrNull();
  return isAdmin(user?.email) && user?.id && user.email ? { id: user.id, email: user.email } : null;
}

const db = () => (dbBackend() === "d1" ? (getD1() as unknown as PermissionDb) : null);

export const GET = async () => permissionsGet(await admin(), db);

export const POST = async (req: Request) => permissionsPost(req, await admin(), db);
