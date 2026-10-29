import { NextResponse } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { isOwner } from "@/lib/owner";

/**
 * Is this session the owner's? lianki-push (workers/push) asks before it
 * accepts a debug socket, forwarding the page's Cookie header over its
 * service binding. 200 for the owner; 404 for anyone else, as /api/dev/log.
 */
export const GET = async () => {
  const user = await authUserOrNull();
  if (!isOwner(user?.email)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ owner: true }, { headers: { "cache-control": "no-store" } });
};
