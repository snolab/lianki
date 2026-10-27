import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { dayKey } from "@/lib/words/schedule";
import { wordsRepo } from "../../../repo";

type Ctx = { params: Promise<{ id: string }> };

const Body = z.object({
  day: z.string().optional(),
  /** First catalog index not yet introduced, as the client sees it. */
  cursor: z.number().int().min(0).nullable().optional(),
  reviews: z
    .array(
      z.object({
        term: z.string().min(1).max(200),
        reading: z.string().max(200).nullable().optional(),
        back: z.string().max(1000).optional(),
        rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
        elapsedMs: z.number().int().min(0).max(3_600_000).nullable().optional(),
        newIndex: z.number().int().min(0).nullable().optional(),
      }),
    )
    .min(1)
    .max(200),
});

/** Submit one screen of ratings at once. */
export async function POST(req: NextRequest, { params }: Ctx) {
  const repo = await wordsRepo();
  if (repo instanceof NextResponse) return repo;
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid reviews" }, { status: 400 });
  const result = await repo.review(
    id,
    parsed.data.reviews,
    dayKey(parsed.data.day),
    new Date(),
    parsed.data.cursor,
  );
  if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(result);
}
