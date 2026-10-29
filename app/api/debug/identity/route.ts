import { NextResponse } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { isOwner } from "@/lib/owner";

/**
 * Who is this session, for lianki-push (workers/push) before it accepts a
 * debug socket — it forwards the page's Cookie header over its service
 * binding. Any signed-in user: {userId, email, owner, name, image}; a guest:
 * 401. `image` is better-auth's user.image (the sign-in provider's picture;
 * Lianki keeps no avatar of its own), for the chat's avatars. The owner
 * gets the owner's thread and pairings; anyone else their own thread only
 * (docs/monitoring.md, "Friends"). /api/dev/whoami stays the owner-only check.
 */
export const GET = async () => {
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
