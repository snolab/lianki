import { NextResponse } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend, getD1 } from "@/lib/d1";
import { myLeafDays, proofFor } from "@/lib/lian/anchor";

export const dynamic = "force-dynamic";

const PRIVATE = { "cache-control": "private, no-store" };

/**
 * GET /api/lian/proof?day=YYYY-MM-DD — the caller's own study-day leaf on
 * that day (docs/lian.md): its preimage, with the caller's salt, the Merkle
 * proof to the day's root, and the day's chain hash. Only ever the signed-in
 * user's own leaf: the user id comes from the session, never the query.
 * Without `day`: the days the caller has a leaf on.
 */
export async function GET(req: Request) {
  const user = await authUserOrNull();
  if (!user) return NextResponse.json({ error: "Sign in" }, { status: 401, headers: PRIVATE });
  if (dbBackend() !== "d1")
    return NextResponse.json({ error: "Not found" }, { status: 404, headers: PRIVATE });
  const day = new URL(req.url).searchParams.get("day");
  const d1 = getD1();
  if (!day) return NextResponse.json({ days: await myLeafDays(d1, user.id) }, { headers: PRIVATE });
  const proof = await proofFor(d1, user.id, day);
  if (!proof)
    return NextResponse.json({ error: "No leaf that day" }, { status: 404, headers: PRIVATE });
  return NextResponse.json(proof, { headers: PRIVATE });
}
