import { NextRequest, NextResponse } from "next/server";
import { dayKey, newRemaining } from "@/lib/words/schedule";
import { wordsRepo } from "../../../repo";

type Ctx = { params: Promise<{ id: string }> };

/**
 * What to study now: the due words, plus where new words start in the catalog
 * and how many may still be introduced today. The client reads the catalog
 * file itself, so new words never round-trip through here.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const repo = await wordsRepo();
  if (repo instanceof NextResponse) return repo;
  const { id } = await params;
  const list = await repo.getList(id);
  if (!list) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const day = dayKey(req.nextUrl.searchParams.get("day"));
  const limit = Math.min(500, Number(req.nextUrl.searchParams.get("limit")) || 200);
  return NextResponse.json({
    list,
    due: await repo.dueCards(id, new Date(), limit),
    newRemaining: newRemaining(
      { new_day: list.newDay, new_today: list.newToday },
      list.params,
      day,
    ),
  });
}
