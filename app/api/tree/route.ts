import { NextRequest, NextResponse } from "next/server";
import { depthParam, treeContext, treeErrorResponse } from "@/lib/tree/api";

/**
 * GET /api/tree?node=<id>&depth=1   a node and its subtree (-1 = all levels)
 * GET /api/tree?path=/plan/japanese  the same, addressed by slugs
 * GET /api/tree                      the roots (depth counts from them)
 *
 * The node tree: docs/calendar-plan.md. Writes go through /api/tree/changes.
 */
export async function GET(req: NextRequest) {
  const ctx = await treeContext();
  if (ctx instanceof NextResponse) return ctx;
  try {
    const q = req.nextUrl.searchParams;
    const depth = depthParam(q.get("depth"), 1);
    let node = q.get("node");
    const path = q.get("path");
    if (!node && path) {
      const found = await ctx.nodes.resolvePath(path);
      if (!found) return NextResponse.json({ error: "No such path" }, { status: 404 });
      node = found.id;
    }
    const nodes = await ctx.nodes.subtree(node || null, depth);
    if (node && !nodes.length) return NextResponse.json({ error: "No such node" }, { status: 404 });
    return NextResponse.json({ nodes });
  } catch (e) {
    return treeErrorResponse(e, "tree.read");
  }
}
