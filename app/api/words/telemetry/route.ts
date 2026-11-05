import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { cappedJsonError, readJsonCapped, tooMany } from "@/lib/security/route-guard";
import { sha256Hex } from "@/lib/security/throttle";
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

/** 200 swipes of at most ~400 bytes each. */
const BODY_MAX = 128 * 1024;
/** Batches per account (D1): a session sends one every few swipes, and on leaving. */
const BATCHES = { max: 120, windowMs: 10 * 60_000 };

/** Swipe telemetry from /words (lib/words/swipe.ts tuning). Sent in batches. */
export async function POST(req: NextRequest) {
  const repo = await wordsRepo();
  if (repo instanceof NextResponse) return repo;
  const limited = await tooMany(`words-telemetry:${await sha256Hex(repo.email)}`, BATCHES);
  if (limited) return limited;
  const body = await readJsonCapped(req, BODY_MAX);
  if (!body.ok) return cappedJsonError(body.status);
  const parsed = z.object({ swipes: z.array(Swipe).min(1).max(200) }).safeParse(body.value);
  if (!parsed.success) return NextResponse.json({ error: "Invalid swipes" }, { status: 400 });
  return NextResponse.json({ stored: await repo.logSwipes(parsed.data.swipes) });
}
