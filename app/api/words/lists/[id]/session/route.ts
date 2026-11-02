import { NextRequest, NextResponse } from "next/server";
import { wordsRepo } from "../../../repo";

type Ctx = { params: Promise<{ id: string }> };

/**
 * What to study now: the due words, plus where new words start in the catalog
 * (`list.cursor`). No daily new-word allowance: /words is an endless scroll,
 * not a daily quota. The client reads the catalog file itself, so new words
 * never round-trip through here.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const repo = await wordsRepo();
  if (repo instanceof NextResponse) return repo;
  const { id } = await params;
  const list = await repo.getList(id);
  if (!list) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const limit = Math.min(500, Number(req.nextUrl.searchParams.get("limit")) || 200);
  return NextResponse.json({
    list,
    due: await repo.dueCards(id, new Date(), limit),
  });
}
