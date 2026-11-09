import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend, getD1 } from "@/lib/d1";
import { isAdmin } from "@/lib/permissions";
import type { PermissionReadDb } from "@/lib/account-permission";
import { permissionsHistoryGet } from "@/lib/permission-route";

/**
 * The history of grants, re-grants and revokes on /dev/permissions, read from
 * security_audit (lib/account-permission.ts, readPermissionHistory). Admin-only,
 * 404 for anyone else. `?before=<id>` pages to older rows.
 */
async function admin() {
  const user = await authUserOrNull();
  return isAdmin(user?.email) && user?.id && user.email ? { id: user.id, email: user.email } : null;
}

const db = () => (dbBackend() === "d1" ? (getD1() as unknown as PermissionReadDb) : null);

export const GET = async (req: Request) => permissionsHistoryGet(req, await admin(), db);
