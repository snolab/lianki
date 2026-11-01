import { NextResponse } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { isOwner } from "@/lib/owner";
import { dbBackend, getD1 } from "@/lib/d1";
import { mintHandoff } from "@/lib/dev-access";
import type { DevAccessDb } from "@/lib/dev-access";

/**
 * The profile menu's jump to the dev server (lib/dev-access.ts): a handoff
 * good for one use within 60 s. The page posts it straight to the dev
 * server's /_lk/dev-auth in a form body, so it is never in a URL.
 * Owner session only; 404 for anyone else.
 */
export const POST = async () => {
  const user = await authUserOrNull();
  if (!isOwner(user?.email) || !user?.id || dbBackend() !== "d1")
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  const h = await mintHandoff(getD1() as unknown as DevAccessDb, {
    id: user.id,
    email: user.email,
  });
  return NextResponse.json(
    { handoff: h.token, expiresMs: h.expiresMs },
    { headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } },
  );
};
