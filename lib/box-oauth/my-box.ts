/** Account self-service: inspect or revoke only the account's current box.
 * Binding new origins and granting chat/eval remain administrative actions.
 */
import { anyBindingByUser, revokeBox, type Binding, type BoxDb } from "./store";

export type MyBox = Pick<Binding, "clientId" | "origin" | "scopes" | "createdAt">;
export async function myBox(db: BoxDb, userId: string): Promise<MyBox | null> {
  const box = await anyBindingByUser(db, userId);
  return box
    ? { clientId: box.clientId, origin: box.origin, scopes: box.scopes, createdAt: box.createdAt }
    : null;
}

export async function revokeMyBox(
  d: {
    db: BoxDb;
    userId: string;
    notify: (clientId: string) => Promise<unknown>;
  },
  clientId: unknown,
): Promise<boolean> {
  if (typeof clientId !== "string" || !clientId) return false;
  // The id also prevents a stale page from disconnecting a newly bound box.
  const own = await myBox(d.db, d.userId);
  if (!own || own.clientId !== clientId) return false;
  if (!(await revokeBox(d.db, own.clientId, d.userId))) return false;
  await d.notify(own.clientId);
  return true;
}
