import { NextResponse } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend, getD1 } from "@/lib/d1";
import { flagIn } from "@/lib/flags";
import { readFlags } from "@/lib/flags-store";
import { isOwner } from "@/lib/owner";
import { userLevelOf } from "@/lib/study-days";

export const dynamic = "force-dynamic";

/**
 * GET /api/levels/me — the caller's learner level (docs/levels.md): tier,
 * study days since the first paid day, the next level. Behind the `levels`
 * flag; the owner sees it while it is off. Anyone else: 404. No UI reads it
 * yet.
 */
export async function GET() {
  const user = await authUserOrNull();
  const owner = isOwner(user?.email);
  if (!owner && !flagIn(await readFlags(), "levels"))
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (dbBackend() !== "d1") return NextResponse.json({ error: "Not found" }, { status: 404 });
  const level = await userLevelOf(getD1(), user?.email ?? null);
  return NextResponse.json(level, { headers: { "cache-control": "private, no-store" } });
}
