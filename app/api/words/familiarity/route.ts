import { NextRequest, NextResponse } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend, getD1 } from "@/lib/d1";
import { userWordCards } from "@/lib/read/progress";
import { lemmasForWords } from "@/lib/read/lemma-server";
import { cardIndex, headsOfWords, hitOf, normWord } from "@/lib/read/words";

/** Words per request: one visible window's examples, with room to spare. */
const MAX_WORDS = 600;

/**
 * POST /api/words/familiarity  { lang, words: string[] }
 *   → { lang, hits: { [word]: [score 0..1, mastered 0|1] }, heads: { [word]: string[] } }
 *
 * How well the signed-in user knows the words of the example sentences on
 * screen (/words, owner 2026-11-03 19:32 JST: the words of an example that
 * have a card show its familiarity). Matched as the reader matches a book's
 * words: the same normalisation, folds and lemma file (lib/read/words.ts,
 * lib/read/lang, lib/read/lemma.ts), one engine for every language. Words
 * with no card are left out of `hits`. One query, scoped to the user.
 *
 * `heads`: the headwords the language's lemma file says each word is a form
 * of ("dû" → "devoir"), so the page can highlight a card's word in its
 * example when the example inflects it (lib/words/example-target.ts): the
 * forms of the words on screen, not the whole file. Words with none are left out.
 */
export async function POST(req: NextRequest) {
  const user = await authUserOrNull();
  if (!user?.email) return NextResponse.json({ error: "login-required" }, { status: 401 });
  if (dbBackend() !== "d1") return NextResponse.json({ error: "unavailable" }, { status: 503 });
  const body = (await req.json().catch(() => null)) as { lang?: unknown; words?: unknown } | null;
  const lang = typeof body?.lang === "string" ? body.lang.toLowerCase().split(/[-_]/)[0] : "";
  if (!/^[a-z]{2,3}$/.test(lang) || !Array.isArray(body?.words))
    return NextResponse.json({ error: "lang-and-words-required" }, { status: 400 });
  const words = [
    ...new Set(
      body.words
        .filter((w): w is string => typeof w === "string" && w.length <= 64)
        .map((w) => normWord(w, lang))
        .filter((w): w is string => !!w),
    ),
  ].slice(0, MAX_WORDS);

  const hits: Record<string, [number, 0 | 1]> = {};
  let heads: Record<string, string[]> = {};
  if (words.length) {
    const [cards, lem] = await Promise.all([
      userWordCards(getD1(), user.email, [lang]),
      lemmasForWords(lang, words),
    ]);
    const idx = cardIndex(cards);
    for (const w of words) {
      const h = hitOf(w, lang, idx, lem);
      if (h) hits[w] = [Math.round(h.score * 1000) / 1000, h.mastered ? 1 : 0];
    }
    heads = await headsOfWords(words, lang, lem, (ws) => lemmasForWords(lang, ws));
  }
  return NextResponse.json(
    { lang, hits, heads },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
