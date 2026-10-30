import { NextRequest, NextResponse } from "next/server";
import type { NodeOp } from "@/lib/repos/nodesD1";
import { treeContext, treeErrorResponse } from "@/lib/tree/api";

/**
 * POST /api/tree/changes {summary, ops}  apply a changeset directly; returns it
 *                                       with its inverse (undo: ./[id]/undo)
 * GET  /api/tree/changes?limit=50       the change log, newest first
 *
 * Ops are generic node ops (lib/repos/nodesD1.ts NodeOp): create, update, move,
 * delete (soft, with the subtree), restore. Partner writes arrive here too,
 * once it has its node-scoped token (docs/calendar-plan.md, P2/P3).
 */
export async function POST(req: NextRequest) {
  const ctx = await treeContext(req.nextUrl.searchParams.get("tz"));
  if (ctx instanceof NextResponse) return ctx;
  try {
    const body = (await req.json().catch(() => null)) as {
      summary?: unknown;
      ops?: unknown;
    } | null;
    if (!body || !Array.isArray(body.ops))
      return NextResponse.json({ error: "Body must be {summary, ops[]}" }, { status: 400 });
    const changeset = await ctx.nodes.apply(body.ops as NodeOp[], {
      summary: typeof body.summary === "string" ? body.summary : "",
      by: "user",
    });
    return NextResponse.json({ changeset });
  } catch (e) {
    return treeErrorResponse(e, "tree.apply");
  }
}

export async function GET(req: NextRequest) {
  const ctx = await treeContext();
  if (ctx instanceof NextResponse) return ctx;
  try {
    const limit = Number(req.nextUrl.searchParams.get("limit") ?? 50) || 50;
    return NextResponse.json({ changesets: await ctx.nodes.changesets(limit) });
  } catch (e) {
    return treeErrorResponse(e, "tree.log");
  }
}
