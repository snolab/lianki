import { auth } from "@/auth";
import { readFlags } from "@/lib/flags-store";
import { boxMeResponse } from "@/lib/box-oauth/me";
import { isDev } from "@/lib/permissions";

export const dynamic = "force-dynamic";

/**
 * A box token's account: name, email, avatar, plus production's flags and the
 * owner role, so the box's pages decide as lianki.com would for this account
 * (lib/box-oauth/me.ts, docs/box-oauth.md, "Flags on a box"). `getSession`
 * has just refreshed the owner snapshot, so `isOwner` reads a fresh one.
 */
export const GET = (req: Request) =>
  boxMeResponse(
    req.headers,
    (headers) => auth.api.getSession({ headers }),
    async (email) => ({ flags: await readFlags(), owner: isDev(email) }),
  );
