/**
 * The one my-box allowlist (docs/box-oauth.md, "Who may have a box"): who may
 * have a box, a box address, box chat and a custom frontend. Owner-managed on
 * /dev/box-clients (and /dev/live-frontends, the same list), default deny.
 * Kept in `live_frontend_allow`; every lookup a box's use goes through reads it
 * (lib/box-oauth/store.ts). Each change is in security_audit.
 *
 * Removing a user ends everything of theirs at once: their custom-frontend
 * previews and their box, with its client and every token.
 */
import { allowByEmail, disallow, listAllowed, type CustomDb } from "@/lib/live-view/custom";
import { anyBindingByUser, revokeBox, type BoxDb } from "./store";

/** The list, with each user's email (the owner's /dev pages). */
export const listBoxAllowed = (db: BoxDb) => listAllowed(db as unknown as CustomDb);

/** Add by email or user id. The user id, or null when no such user. */
export const allowBoxUser = (db: BoxDb, emailOrId: string, by: string, now = Date.now()) =>
  allowByEmail(db as unknown as CustomDb, emailOrId, by, now);

/**
 * Take a user off the list: their previews stop and their box is revoked. The
 * revoked box's client id, for the caller to close its chat socket; null when
 * they had no live box.
 */
export async function disallowBoxUser(
  db: BoxDb,
  userId: string,
  by: string,
  now = Date.now(),
): Promise<{ removed: boolean; revokedClientId: string | null }> {
  const removed = await disallow(db as unknown as CustomDb, userId, by, now);
  const box = await anyBindingByUser(db, userId);
  const revoked = box ? await revokeBox(db, box.clientId, by, now) : false;
  return { removed, revokedClientId: revoked && box ? box.clientId : null };
}
