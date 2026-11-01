import { NextResponse } from "next/server";
import { authSessionOrNull } from "@/app/signInEmail";
import { DEV_BRIDGE_HEADER } from "@/lib/dev-bridge";
import { devBridgeUser } from "@/lib/dev-bridge-user";
import { sessionTag } from "@/lib/dev-eval";
import { isOwner } from "@/lib/owner";
import { flushSignedOutSoon } from "@/lib/push-signed-out";

/**
 * Who is this session, for lianki-push (workers/push) before it accepts a
 * debug socket — it forwards the page's Cookie header over its service
 * binding. Any signed-in user: {userId, email, owner, name, image}; a guest:
 * 401. `image` is better-auth's user.image (the sign-in provider's picture;
 * Lianki keeps no avatar of its own), for the chat's avatars. The owner
 * gets the owner's thread and pairings; anyone else their own thread only
 * (docs/monitoring.md, "Friends"). /api/dev/whoami stays the owner-only check.
 * `session` is sessionTag(session id) — a hash, never the id or its token —
 * and `sessionUntil` its expiry: the hub binds an eval grant's auto-renewal to
 * the session that approved it (docs/monitoring.md, "Renewal"). A dev-bridge
 * answer has neither, so a grant approved there is never renewed.
 *
 * Or the dev bridge (lib/dev-bridge.ts): the owner's whole-page dev server,
 * which has no lianki.com cookie, sends DEV_BRIDGE_SECRET instead and is told
 * it is the owner. A request carrying the header is judged on it alone — a
 * wrong one is 401, never a fall back to the cookie.
 */
export const GET = async (req: Request) => {
  const bridge = req.headers.get(DEV_BRIDGE_HEADER);
  if (bridge !== null) return bridgeIdentity(req);
  const got = await authSessionOrNull();
  const user = got?.user;
  if (!user?.id) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  // An event that happens anyway: retry sign-out notices still in the outbox.
  if (isOwner(user.email)) flushSignedOutSoon();
  const session = got?.session;
  const until = session?.expiresAt ? new Date(session.expiresAt).getTime() : NaN;
  return NextResponse.json(
    {
      userId: user.id,
      email: user.email ?? "",
      owner: isOwner(user.email),
      name: user.name ?? "",
      image: user.image ?? "",
      ...(session?.id ? { session: await sessionTag(session.id) } : {}),
      ...(Number.isFinite(until) ? { sessionUntil: until } : {}),
    },
    { headers: { "cache-control": "no-store" } },
  );
};

async function bridgeIdentity(req: Request) {
  const user = await devBridgeUser(req);
  if (!user) return NextResponse.json({ error: "Bad bridge" }, { status: 401 });
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
