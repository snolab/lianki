import { NextResponse } from "next/server";
import { json, notFound, readerCtx } from "@/lib/read/reader-route";
import { langClause } from "@/lib/read/progress";
import { readFlags } from "@/lib/flags-store";
import { isOwner } from "@/lib/owner";
import { sideReviewOn } from "@/lib/read/reader-book";
import { dueBookWords, type DueCardRow } from "@/lib/read/side-review";

/**
 * GET /api/read/[id]/word-due — the book's words whose card (any of his word
 * lists in the book's language, as /words schedules it) is due now:
 * `{ due: string[] }`, the word map's keys. The reader's side-by-side review
 * jumps to them (docs/books-plan.md, "Side-by-side word review"). One query,
 * scoped to his email.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await readerCtx((await params).id);
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.email || !sideReviewOn(await readFlags(), isOwner(ctx.email))) return notFound();
  const { words } = await ctx.load();
  const { sql, args } = langClause([words.stats.lang]);
  const { results } = await ctx.db
    .prepare(
      `SELECT c.term AS term, c.reading AS reading, l.lang AS lang,
         json_extract(c.card, '$.due') AS due
       FROM word_cards c JOIN word_lists l ON l.email = c.email AND l.id = c.list_id
       WHERE c.email = ?${sql}`,
    )
    .bind(ctx.email, ...args)
    .all<DueCardRow>();
  return json({ due: dueBookWords(words.stats, results, Date.now()) });
}
