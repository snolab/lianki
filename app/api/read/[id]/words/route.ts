import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { headers } from "next/headers";
import { getReadMaterialById } from "@/lib/getReadMaterialsCollection";
import { dbBackend, getD1 } from "@/lib/d1";
import { materialWords, userDeckTerms, userWordCards } from "@/lib/read/progress";
import { cardIndex, foldsOf, hitOf, inDict, inKeys, statsLemmas, termKeys } from "@/lib/read/words";

/**
 * GET /api/read/[id]/words — every distinct word of the reader's own material,
 * with what their cards give it, for the scan summary in the reader's header:
 *
 *   words: [word, count, score 0..1 (-1: no card), mastered 0|1, in own deck 0|1, name 0|1,
 *           in the language's dictionary 0|1, headwords it is a form of]
 *
 * The last two come from the language's lemma file (lib/read/lemma.ts), stored
 * with the book's words, so the device needs no dictionary download: a word
 * without a card is "new" when it is in the dictionary or one of its
 * headwords is in a list ("regarda" → "regarder").
 *
 * "In own deck" (one of their imported lists has the word) is only looked up
 * for words without a card. Whether a word without a card is in one of the
 * public word lists is decided on the device, from the catalogs it caches.
 * Two queries, both scoped to the signed-in user.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const material = await getReadMaterialById(session.user.id, id);
  if (!material) return NextResponse.json({ error: "Material not found" }, { status: 404 });

  const { stats } = await materialWords(material, session.user.id);
  const email = session.user.email;
  const db = dbBackend() === "d1" && email ? getD1() : null;
  const [cards, deck] = db
    ? await Promise.all([
        userWordCards(db, email, [stats.lang]),
        userDeckTerms(db, email, stats.lang),
      ])
    : [[], []];
  const idx = cardIndex(cards);
  const deckKeys = new Set<string>();
  for (const e of deck) for (const k of termKeys(e.term, e.reading, stats.lang)) deckKeys.add(k);

  const names = new Set(stats.names);
  const lem = statsLemmas(stats);
  const words = stats.words.map(([w, n]) => {
    const name = names.has(w) ? 1 : 0;
    const h = hitOf(w, stats.lang, idx, lem);
    if (h) return [w, n, Math.round(h.score * 1000) / 1000, h.mastered ? 1 : 0, 0, name] as const;
    const dict = inDict(w, stats.lang, lem) ? 1 : 0;
    const cheap = foldsOf(w, stats.lang);
    const heads = lem ? foldsOf(w, stats.lang, lem).filter((f) => !cheap.includes(f)) : [];
    const own = inKeys(w, stats.lang, deckKeys, lem) ? 1 : 0;
    return [w, n, -1, 0, own, name, dict, heads] as const;
  });

  return NextResponse.json(
    { lang: stats.lang, tokens: stats.tokens, distinct: stats.distinct, words },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
