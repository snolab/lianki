import { NextResponse } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { isOwner } from "@/lib/owner";
import { isUserId } from "@/lib/dev-eval";
import { listFriends, setBlocked } from "@/lib/push-friends";

/**
 * Owner-only: the debug chat's users (GET) and Block / unblock (POST
 * {userId, action}). Passed on to lianki-push over the PUSH binding. 404 for
 * anyone else, as /api/dev/membership.
 */
const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });
const noBinding = () =>
  NextResponse.json({ error: "lianki-push is not bound here" }, { status: 503 });

export const GET = async () => {
  if (!isOwner((await authUserOrNull())?.email)) return notFound();
  const friends = await listFriends();
  if (!friends) return noBinding();
  return NextResponse.json({ friends }, { headers: { "cache-control": "no-store" } });
};

export const POST = async (req: Request) => {
  if (!isOwner((await authUserOrNull())?.email)) return notFound();
  const body = (await req.json().catch(() => ({}))) as { userId?: unknown; action?: unknown };
  if (!isUserId(body.userId) || (body.action !== "block" && body.action !== "unblock"))
    return NextResponse.json(
      { error: "expected {userId, action: block|unblock}" },
      { status: 400 },
    );
  try {
    const out = await setBlocked(body.userId, body.action === "block");
    return out ? NextResponse.json(out) : noBinding();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
};
