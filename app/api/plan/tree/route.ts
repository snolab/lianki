import { NextRequest, NextResponse } from "next/server";
import { depthParam, treeContext, treeErrorResponse } from "@/lib/tree/api";

/**
 * GET /api/plan/tree?depth=-1&locale=en — the user's study plan: the subtree
 * under their root tagged `plan`, made on first use. The plan is a convention
 * on the generic node tree (docs/calendar-plan.md), not a structure of its own.
 */
export async function GET(req: NextRequest) {
  const ctx = await treeContext();
  if (ctx instanceof NextResponse) return ctx;
  try {
    const q = req.nextUrl.searchParams;
    const root = await ctx.nodes.ensurePlanRoot(q.get("locale") ?? "en");
    const nodes = await ctx.nodes.subtree(root.id, depthParam(q.get("depth"), -1));
    return NextResponse.json({ root: root.id, nodes });
  } catch (e) {
    return treeErrorResponse(e, "plan.tree");
  }
}
