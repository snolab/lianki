import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend, getD1 } from "@/lib/d1";
import { isOwner } from "@/lib/owner";
import type { SiteRoleDb } from "@/lib/site-role";
import { ownersGet, ownersPost } from "@/lib/site-role-route";

/**
 * Who is the owner (site_role, lib/site-role.ts). Owner-only, 404 for anyone
 * else, as every /api/dev route. GET lists them; POST `{op: "grant"|"revoke",
 * email}` (same-origin JSON only) changes one, by exact address, and audits it.
 * A revocation reaches every isolate within OWNER_CACHE_MS (30 s), no deploy.
 */
async function owner() {
  const user = await authUserOrNull();
  return isOwner(user?.email) && user?.id && user.email ? { id: user.id, email: user.email } : null;
}

const db = () => (dbBackend() === "d1" ? (getD1() as unknown as SiteRoleDb) : null);

export const GET = async () => ownersGet(await owner(), db);

export const POST = async (req: Request) => ownersPost(req, await owner(), db);
