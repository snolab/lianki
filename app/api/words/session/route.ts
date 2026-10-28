import { NextRequest, NextResponse } from "next/server";
import { dayKey } from "@/lib/words/schedule";
import { wordsRepo } from "../repo";

/**
 * Due words for many lists at once (study all / a group): one round trip and
 * one query instead of a request per list. ?lists=id1,id2&day=YYYY-MM-DD
 */
export async function GET(req: NextRequest) {
  const repo = await wordsRepo();
  if (repo instanceof NextResponse) return repo;
  const ids = (req.nextUrl.searchParams.get("lists") ?? "").split(",").filter(Boolean).slice(0, 90); // D1 binds at most 100 parameters per statement
  const limit = Math.min(1000, Number(req.nextUrl.searchParams.get("limit")) || 400);
  return NextResponse.json(
    await repo.sessionMany(ids, dayKey(req.nextUrl.searchParams.get("day")), new Date(), limit),
  );
}
