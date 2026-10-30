import { NextResponse } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { getAuth } from "@/auth";
import { DEV_BRIDGE_HEADER, devBridgeMatches } from "@/lib/dev-bridge";
import { isOwner, ownerEmails } from "@/lib/owner";

/**
 * Who is this session, for lianki-push (workers/push) before it accepts a
 * debug socket — it forwards the page's Cookie header over its service
 * binding. Any signed-in user: {userId, email, owner, name, image}; a guest:
 * 401. `image` is better-auth's user.image (the sign-in provider's picture;
 * Lianki keeps no avatar of its own), for the chat's avatars. The owner
 * gets the owner's thread and pairings; anyone else their own thread only
 * (docs/monitoring.md, "Friends"). /api/dev/whoami stays the owner-only check.
 *
 * Or the dev bridge (lib/dev-bridge.ts): the owner's whole-page dev server,
 * which has no lianki.com cookie, sends DEV_BRIDGE_SECRET instead and is told
 * it is the owner. A request carrying the header is judged on it alone — a
 * wrong one is 401, never a fall back to the cookie.
 */
export const GET = async (req: Request) => {
  const bridge = req.headers.get(DEV_BRIDGE_HEADER);
  if (bridge !== null) return bridgeIdentity(bridge);
  const user = await authUserOrNull();
  if (!user?.id) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  return NextResponse.json(
    {
      userId: user.id,
      email: user.email ?? "",
      owner: isOwner(user.email),
      name: user.name ?? "",
      image: user.image ?? "",
    },
    { headers: { "cache-control": "no-store" } },
  );
};

async function bridgeIdentity(sent: string) {
  if (!devBridgeMatches(sent, process.env.DEV_BRIDGE_SECRET)) {
    return NextResponse.json({ error: "Bad bridge" }, { status: 401 });
  }
  const email = ownerEmails()[0];
  const ctx = email ? await (await getAuth()).$context : null;
  const found = ctx && email ? await ctx.internalAdapter.findUserByEmail(email) : null;
  if (!found?.user) return NextResponse.json({ error: "No owner account" }, { status: 401 });
  const user = found.user;
  return NextResponse.json(
    {
      userId: user.id,
      email: user.email,
      owner: true,
      name: user.name ?? "",
      image: user.image ?? "",
    },
    { headers: { "cache-control": "no-store" } },
  );
}
