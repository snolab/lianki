import { NextRequest, NextResponse } from "next/server";
import { wordsRepo } from "../repo";

/**
 * Today's goal (/today, lib/today/goal.ts): per list, the cards reviewed since
 * the caller's local midnight (?since=<ISO instant>) that are not due again.
 * Counts only. The cards left come from GET /api/words/lists (`due`).
 */
export async function GET(req: NextRequest) {
  const repo = await wordsRepo();
  if (repo instanceof NextResponse) return repo;
  const raw = req.nextUrl.searchParams.get("since") ?? "";
  const since = new Date(raw);
  const now = new Date();
  // A day at most: an older or unparsable start reads as the last 24 hours.
  const floor = now.getTime() - 24 * 3600_000;
  const start = Number.isNaN(since.getTime()) || since.getTime() < floor ? new Date(floor) : since;
  const done = await repo.doneSince(start.toISOString(), now);
  return NextResponse.json({ done }, { headers: { "cache-control": "no-store" } });
}
