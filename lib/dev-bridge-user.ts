import { getAuth } from "@/auth";
import { DEV_BRIDGE_HEADER, devBridgeMatches } from "@/lib/dev-bridge";
import { refreshOwners } from "@/lib/owner-store";

/** The owner's account, as better-auth stores it. */
export type BridgeUser = {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
};

/**
 * Who a dev-bridge request is (lib/dev-bridge.ts). Used by only the routes the
 * owner opened to it: /api/debug/identity, /api/words/tts, /api/debug/stt,
 * /api/prefs (his settings, docs/prefs-sync.md).
 *
 * - `undefined`: no bridge header — the caller uses the session as usual.
 * - `null`: a header that does not match DEV_BRIDGE_SECRET (or no owner
 *   account) — refuse; never fall back to the cookie.
 * - the owner's user: the header matched. Never anyone else.
 */
export async function devBridgeUser(req: Request): Promise<BridgeUser | null | undefined> {
  const sent = req.headers.get(DEV_BRIDGE_HEADER);
  if (sent === null) return undefined;
  if (!devBridgeMatches(sent, process.env.DEV_BRIDGE_SECRET)) return null;
  // The oldest active grant in site_role. No session here, so this also
  // refreshes the snapshot for the route's own isOwner check.
  const email = (await refreshOwners())[0];
  if (!email) return null;
  const ctx = await (await getAuth()).$context;
  const found = await ctx.internalAdapter.findUserByEmail(email);
  return found?.user ? (found.user as BridgeUser) : null;
}
