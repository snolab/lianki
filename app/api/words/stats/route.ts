import { NextRequest, NextResponse } from "next/server";
import { STATS_DAYS } from "@/lib/words/stats";
import { wordsRepo } from "../repo";

/**
 * The /words picker's stats (WordsStats.tsx): the signed-in user's study per
 * local day and list over the heatmap's span. One small read, fetched when
 * the picker opens; the counts that are already on the lists (due, cards) are
 * not repeated here.
 *
 * `?tz=` is the reader's UTC offset in minutes east (JST 540).
 */
export async function GET(req: NextRequest) {
  const repo = await wordsRepo();
  if (repo instanceof NextResponse) return repo;
  const tz = Number(req.nextUrl.searchParams.get("tz") ?? 0);
  const offset = Number.isFinite(tz) ? Math.max(-840, Math.min(840, Math.trunc(tz))) : 0;
  // A day of slack on each side of the span covers any offset.
  const since = new Date(Date.now() - (STATS_DAYS + 1) * 86_400_000);
  const rows = await repo.activity(since, offset);
  return NextResponse.json(
    { days: rows.map((r) => [r.day, r.list_id, r.words, r.fresh]) },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
