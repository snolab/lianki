import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { dayKey } from "@/lib/words/schedule";
import { wordsRepo } from "../../../repo";

type Ctx = { params: Promise<{ id: string }> };

/** Undo a word's latest review (one level). 409 when there is nothing to undo. */
export async function POST(req: NextRequest, { params }: Ctx) {
  const repo = await wordsRepo();
  if (repo instanceof NextResponse) return repo;
  const { id } = await params;
  const parsed = z
    .object({ term: z.string().min(1).max(200), day: z.string().optional() })
    .safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid term" }, { status: 400 });
  const result = await repo.undo(id, parsed.data.term, dayKey(parsed.data.day));
  if (!result) return NextResponse.json({ error: "Nothing to undo" }, { status: 409 });
  return NextResponse.json(result);
}
