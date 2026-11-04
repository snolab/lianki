import { NextResponse } from "next/server";
import { sameOriginJsonPost } from "@/lib/security/same-origin";
import { connectionContext, fail } from "@/lib/connections/route";
import { disconnect } from "@/lib/connections/google";

export const dynamic = "force-dynamic";

/**
 * POST /api/connections/google/disconnect → {deleted, revoked}
 *
 * Revokes the grant at Google (best effort) and deletes the row whatever
 * Google answered. Sign-in with Google is a separate `account` row and is
 * never touched.
 */
export async function POST(req: Request) {
  if (!sameOriginJsonPost(req)) return fail("Forbidden", 403);
  const ctx = await connectionContext();
  if (ctx instanceof NextResponse) return ctx;
  const out = await disconnect(ctx.db, ctx.userId, process.env.AUTH_SECRET);
  console.log("connections.google.disconnected", { user: ctx.userId, revoked: out.revoked });
  return NextResponse.json(out, { headers: { "cache-control": "no-store" } });
}
