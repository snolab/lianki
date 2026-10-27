import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { wordsRepo } from "../../../repo";

type Ctx = { params: Promise<{ id: string }> };

/** Which of these catalog terms already have a card, so they are not shown as new. */
export async function POST(req: NextRequest, { params }: Ctx) {
  const repo = await wordsRepo();
  if (repo instanceof NextResponse) return repo;
  const { id } = await params;
  const parsed = z
    .object({ terms: z.array(z.string().max(200)).max(500) })
    .safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid terms" }, { status: 400 });
  return NextResponse.json({ known: [...(await repo.knownTerms(id, parsed.data.terms))] });
}
