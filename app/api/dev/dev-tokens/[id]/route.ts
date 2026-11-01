import { NextResponse } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { isOwner } from "@/lib/owner";
import { dbBackend, getD1 } from "@/lib/d1";
import { revokeToken } from "@/lib/dev-access";
import type { DevAccessDb } from "@/lib/dev-access";

/** Revoke one dev access token, and with it its dev-server sessions. Owner only; 404 otherwise. */
export const DELETE = async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await authUserOrNull();
  if (!isOwner(user?.email) || !user?.id || dbBackend() !== "d1")
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { id } = await ctx.params;
  const ok = await revokeToken(getD1() as unknown as DevAccessDb, user.id, id);
  if (ok) console.log(JSON.stringify({ event: "dev-token.revoked", id }));
  return NextResponse.json(
    { ok },
    { status: ok ? 200 : 404, headers: { "cache-control": "no-store" } },
  );
};
