/**
 * The session the app sees for a box-token request: the bound account, read
 * from D1, from the signed identity the Worker's gate set (gate.ts). A bad
 * identity is no session, never a fall back to anything else.
 */
import { getD1 } from "@/lib/d1";
import { BOX_IDENTITY_HEADER, verifyBoxIdentity } from "./identity";
import { boxUser, type BoxDb } from "./store";

export async function boxSessionFrom(headers: Headers, db?: BoxDb) {
  const who = await verifyBoxIdentity(process.env.AUTH_SECRET, headers.get(BOX_IDENTITY_HEADER));
  if (!who) return null;
  const user = await boxUser(db ?? (getD1() as unknown as BoxDb), who.userId);
  if (!user) return null;
  const at = (v: string | null) => new Date(v ?? 0);
  const now = new Date();
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name ?? "",
      image: user.image,
      emailVerified: Boolean(user.emailVerified),
      createdAt: at(user.createdAt),
      updatedAt: at(user.updatedAt),
    },
    session: {
      id: `box:${who.clientId}`,
      userId: user.id,
      token: "",
      expiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
      updatedAt: now,
      ipAddress: null,
      userAgent: null,
    },
  };
}
