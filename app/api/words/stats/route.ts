import { NextRequest, NextResponse } from "next/server";
import { STATS_DAYS, offsetSpans } from "@/lib/words/stats";
import { wordsRepo } from "../repo";

/**
 * The /words picker's stats (WordsStats.tsx): the signed-in user's study per
 * local day and list over the heatmap's span. One small read, fetched when
 * the picker opens; the counts that are already on the lists (due, cards) are
 * not repeated here.
 *
 * `?zone=` is the reader's IANA time zone, so each review falls on the day it
 * had then (DST included); `?tz=`, the offset in minutes east (JST 540), is
 * the fallback for a zone this runtime does not know.
 */
export async function GET(req: NextRequest) {
  const repo = await wordsRepo();
  if (repo instanceof NextResponse) return repo;
  const q = req.nextUrl.searchParams;
  const tz = Number(q.get("tz") ?? 0);
  const offset = Number.isFinite(tz) ? Math.max(-840, Math.min(840, Math.trunc(tz))) : 0;
  const now = new Date();
  // A day of slack on each side of the span covers any offset.
  const since = new Date(now.getTime() - (STATS_DAYS + 1) * 86_400_000);
  const zone = (q.get("zone") ?? "").slice(0, 64);
  const spans = zone ? offsetSpans(zone, since, now) : null;
  const rows = await repo.activity(since, spans ?? offset);
  return NextResponse.json(
    { days: rows.map((r) => [r.day, r.list_id, r.words, r.fresh]) },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
