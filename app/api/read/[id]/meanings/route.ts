import { NextResponse } from "next/server";
import { json, readerCtx } from "@/lib/read/reader-route";
import { readBookMeanings } from "@/lib/read/select-meaning-server";
import { statsLemmas } from "@/lib/read/words";

/**
 * GET /api/read/[id]/meanings — his /words cards' meanings that this book can
 * show, for the selection card (lib/read/select-meaning.ts): read once, so a
 * selected word or phrase shows its card's meaning with no wait.
 *
 *   → { cards: [{ term, reading, back, listId }], forms: [[bookWord, cardIndex]],
 *       heads: [[inflectedBookWord, lemma]] }
 *
 * Scoped to his email.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await readerCtx((await params).id);
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.email) return json({ cards: [], forms: [], heads: [] });
  const { stats } = (await ctx.load()).words;
  return json(
    await readBookMeanings(
      ctx.db,
      ctx.email,
      stats.lang,
      stats.words.map(([w]) => w),
      statsLemmas(stats),
    ),
  );
}
