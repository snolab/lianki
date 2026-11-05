import { NextRequest, NextResponse } from "next/server";
import { dueLoad, MAX_DAYS } from "@/lib/plan/due-load";
import { treeContext, treeErrorResponse } from "@/lib/tree/api";
import { isDay, localDay } from "@/lib/tree/tz";

/**
 * GET /api/plan/load?from=2026-11-02&days=14&tz=Europe/Berlin
 *
 * Reviews due per local day (page notes + word cards) with an estimate in
 * minutes. `tz` (the browser's) wins over the stored zone; with neither the
 * days are UTC days and the answer says `tzKnown: false` — the client then
 * writes times as ISO with Z, never a guessed zone. `from` defaults to today
 * in that zone; `days` to 14 (at most 60).
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const ctx = await treeContext(q.get("tz"));
  if (ctx instanceof NextResponse) return ctx;
  try {
    const fromRaw = q.get("from");
    if (fromRaw && !isDay(fromRaw))
      return NextResponse.json({ error: "from must be YYYY-MM-DD" }, { status: 400 });
    const from = fromRaw ?? localDay(ctx.zone.tz, new Date());
    const days = Math.min(MAX_DAYS, Math.max(1, Number(q.get("days") ?? 14) || 14));
    const load = await dueLoad(ctx.db, { email: ctx.user.email, tz: ctx.zone.tz, from, days });
    return NextResponse.json({ ...load, tzKnown: ctx.zone.known });
  } catch (e) {
    return treeErrorResponse(e, "plan.load");
  }
}
