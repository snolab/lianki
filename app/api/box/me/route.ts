import { auth } from "@/auth";
import { readFlags } from "@/lib/flags-store";
import { boxMeResponse } from "@/lib/box-oauth/me";
import { isAdmin, isDev } from "@/lib/permissions";

export const dynamic = "force-dynamic";

/**
 * A box token's account: name, email, avatar, plus production's flags and its
 * permissions (isAdmin / isDev, lib/permissions.ts), so the box's pages and
 * its server decide as lianki.com would for this account (lib/box-oauth/me.ts,
 * docs/box-oauth.md, "Flags on a box"). `getSession` has just refreshed the
 * permission snapshot, so both read a fresh one.
 */
export const GET = (req: Request) =>
  boxMeResponse(
    req.headers,
    (headers) => auth.api.getSession({ headers }),
    async (email) => {
      const dev = isDev(email);
      // `owner`: what the box's pages read for "on for the owner" flags (= dev).
      return { flags: await readFlags(), owner: dev, isAdmin: isAdmin(email), isDev: dev };
    },
  );
