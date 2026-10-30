import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { wordsRepo } from "../../../repo";

type Ctx = { params: Promise<{ id: string }> };

/** The same bounds as a new list's name (POST /api/words/lists). */
const Body = z.object({ name: z.string().trim().min(1).max(120) });

/**
 * Rename a list or group. A POST under /lists/:id/, like review and undo, so
 * the client's offline queue (IndexedDB `pending`) sends it the same way.
 * 404 for an unknown list: the queue then drops the op (it was deleted).
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const repo = await wordsRepo();
  if (repo instanceof NextResponse) return repo;
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid name" }, { status: 400 });
  if (!(await repo.getList(id))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await repo.renameList(id, parsed.data.name);
  return NextResponse.json({ list: await repo.getList(id) });
}
