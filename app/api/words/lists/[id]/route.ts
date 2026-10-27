import { NextRequest, NextResponse } from "next/server";
import { wordsRepo } from "../../repo";

type Ctx = { params: Promise<{ id: string }> };

/** Update the list's FSRS parameters. */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const repo = await wordsRepo();
  if (repo instanceof NextResponse) return repo;
  const { id } = await params;
  if (!(await repo.getList(id))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = (await req.json().catch(() => null)) as { params?: unknown } | null;
  return NextResponse.json({ params: await repo.updateParams(id, body?.params) });
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const repo = await wordsRepo();
  if (repo instanceof NextResponse) return repo;
  const { id } = await params;
  await repo.deleteList(id);
  return NextResponse.json({ ok: true });
}
