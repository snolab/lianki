import { NextRequest, NextResponse } from "next/server";
import { WordEntriesD1Repo } from "@/lib/repos/wordEntriesD1";
import { wordsRepo } from "../../../repo";

type Ctx = { params: Promise<{ id: string }> };

/**
 * An imported list's words, in the shape of a catalog file
 * (public/words/<list>.json: `{ entries }`), so /words loads and caches it
 * exactly as it does a catalog.
 */
export async function GET(_req: NextRequest, { params }: Ctx) {
  const repo = await wordsRepo();
  if (repo instanceof NextResponse) return repo;
  const { id } = await params;
  const list = await repo.getList(id);
  if (!list?.source?.startsWith("anki:"))
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  const entries = await new WordEntriesD1Repo(repo.db, repo.email).entries(id);
  return NextResponse.json({ entries }, { headers: { "Cache-Control": "private, no-cache" } });
}
