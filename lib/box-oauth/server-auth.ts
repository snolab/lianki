/**
 * `auth.api.getSession` on a box's own server (auth.ts; docs/box-oauth.md,
 * "The box's server sees the sign-in"). Kept apart from server-session.ts so
 * its rules stay testable without the env or the permission snapshot.
 */
import { type Grant, setPermissionSnapshot } from "@/lib/permissions";
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
  const account = await boxServerAccount(
    headers.get("authorization")?.match(/^Bearer (lkb_[A-Za-z0-9_-]{16,256})$/)?.[1] ??
      boxAccessFromCookies(headers.get("cookie")),
    {
      provider: config.provider,
      origin: boxOriginFromEnv(),
    },
  );
  if (!account) return null;
  // isAdmin()/isDev() answer from a snapshot (lib/permissions.ts). On a box it
  // is lianki.com's answer for this one account (/api/box/me), never the box's
  // local D1 (where nobody holds anything): its own /dev pages show to a dev
  // as on lianki.com. Their API calls still go to lianki.com, where a token
  // never reaches /api/dev.
  const grants: Grant[] = [];
  if (account.isAdmin) grants.push({ email: account.email, permission: "admin" });
  if (account.isDev) grants.push({ email: account.email, permission: "dev" });
  setPermissionSnapshot(grants);
  return boxServerSession(account);
}
