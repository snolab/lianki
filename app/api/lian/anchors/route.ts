import { NextResponse } from "next/server";
import { dbBackend, getD1 } from "@/lib/d1";
import { listAnchors } from "@/lib/lian/anchor";

export const dynamic = "force-dynamic";

/**
 * GET /api/lian/anchors[?limit=&before=YYYY-MM-DD] — public: the study
 * ledger's daily anchors, newest first (docs/lian.md). Day, Merkle root,
 * previous and chain hash, leaf count — no user data. Anyone can recompute
 * the chain from these (packages/lian `verifyChain`).
 */
export async function GET(req: Request) {
  if (dbBackend() !== "d1") return NextResponse.json({ anchors: [] });
  const q = new URL(req.url).searchParams;
  const anchors = await listAnchors(getD1(), {
    limit: Number(q.get("limit") ?? 400),
    before: q.get("before") ?? undefined,
  });
  return NextResponse.json(
    { anchors },
    { headers: { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" } },
  );
}
