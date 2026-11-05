import { NextResponse } from "next/server";
import { treeContext, treeErrorResponse } from "@/lib/tree/api";

/**
 * POST /api/tree/changes/<id>/undo — apply the changeset's inverse as a new
 * changeset (so an undo can itself be undone). 409 when a node it touches has
 * changed since, or when it was already undone.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await treeContext();
  if (ctx instanceof NextResponse) return ctx;
  try {
    const { id } = await params;
    return NextResponse.json({ changeset: await ctx.nodes.undo(id, "user") });
  } catch (e) {
    return treeErrorResponse(e, "tree.undo");
  }
}
