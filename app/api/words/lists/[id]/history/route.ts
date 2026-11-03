import { NextRequest, NextResponse } from "next/server";
import { wordsRepo } from "../../../repo";

type Ctx = { params: Promise<{ id: string }> };

/**
 * One word's grades, oldest first, for the stamps in the word sheet
 * (WordsClient.tsx SlipSheet): `[rating, reviewedAt][]`. The signed-in user's
 * own reviews only. Fetched when the sheet opens.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const repo = await wordsRepo();
  if (repo instanceof NextResponse) return repo;
  const { id } = await params;
  const term = req.nextUrl.searchParams.get("term") ?? "";
  if (!term || term.length > 200 || id.length > 64)
    return NextResponse.json({ error: "Invalid word" }, { status: 400 });
  const rows = await repo.history(id, term);
  return NextResponse.json(
    { reviews: rows.map((r) => [r.rating, r.at]) },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
