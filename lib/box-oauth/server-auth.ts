/**
 * `auth.api.getSession` on a box's own server (auth.ts; docs/box-oauth.md,
 * "The box's server sees the sign-in"). Kept apart from server-session.ts so
 * its rules stay testable without the env or the owner snapshot.
 */
import { setOwnerSnapshot } from "@/lib/owner";
import { boxConfig } from "./mode";
import {
  boxAccessFromCookies,
  boxOriginFromEnv,
  boxServerAccount,
  boxServerSession,
} from "./server-session";

export async function boxServerGetSession(headers: Headers | undefined) {
  const config = boxConfig();
  if (!config || !headers) return null;
  const account = await boxServerAccount(boxAccessFromCookies(headers.get("cookie")), {
    provider: config.provider,
    origin: boxOriginFromEnv(),
  });
  if (!account) return null;
  // isOwner() answers from a snapshot (lib/owner.ts). On a box it is
  // lianki.com's answer for this one account, not the box's local D1 (where
  // nobody is the owner): its own /dev pages show to the owner as on lianki.com.
  // Their API calls still go to lianki.com, where a token never reaches /api/dev.
  setOwnerSnapshot(account.owner ? [account.email] : []);
  return boxServerSession(account);
}
