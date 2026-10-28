import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { wordsRepo } from "../repo";

const Swipe = z.object({
  at: z.string().max(40),
  finger: z.number().finite(),
  v: z.number().finite(),
  projected: z.number().finite(),
  rating: z.number().int().min(1).max(4).nullable(),
  a: z.number().finite().positive(),
  params: z.string().max(200).optional(),
});

/** Swipe telemetry from /words (lib/words/swipe.ts tuning). Sent in batches. */
export async function POST(req: NextRequest) {
  const repo = await wordsRepo();
  if (repo instanceof NextResponse) return repo;
  const parsed = z
    .object({ swipes: z.array(Swipe).min(1).max(200) })
    .safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid swipes" }, { status: 400 });
  return NextResponse.json({ stored: await repo.logSwipes(parsed.data.swipes) });
}
