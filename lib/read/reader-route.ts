// The gate every reader-v2 route goes through (docs/books-plan.md, "Review
// units"): a session, D1, the flag `read.reader-v2` (or the owner), and the
// material being the user's own. Anything else answers before any reader row
// is touched: 401 without a session, 404 otherwise (the feature does not
// exist for this user, or the book is not theirs).

import { exampleFinder } from "./gloss";
import { offSiteHeaders } from "@/lib/security/route-guard";
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { dbBackend, getD1 } from "@/lib/d1";
import { readFlags } from "@/lib/flags-store";
import { getReadMaterialById, type ReadMaterial } from "@/lib/getReadMaterialsCollection";
import { isOwner } from "@/lib/owner";
import { materialWords, userWordCards, type MaterialWords } from "./progress";
import { hashOf, readerBook, readerV2On, type ReaderBook } from "./reader-book";
import { saveContentHash, type BookRef, type D1Batch } from "./reader-store";
import type { WordContext } from "./reader-service";
import { bookPhrase } from "./select-meaning";
import type { RangeWord } from "./book-word-list";
import { langIn } from "./lang-detect";
import { cardIndex, statsLemmas, wordLang } from "./words";
import { isVibeMaterial } from "@/lib/vibe/private-speech";

export interface ReaderCtx {
  userId: string;
  email: string | null;
  db: D1Batch;
  material: ReadMaterial;
  ref: BookRef;
  /** The book's sentences and its word stats (reads the content once). */
  load(): Promise<{ book: ReaderBook; words: MaterialWords }>;
}

export const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });
export const badRequest = (error: string) => NextResponse.json({ error }, { status: 400 });
export const json = <T>(body: T, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

export async function readerCtx(materialId: string): Promise<ReaderCtx | NextResponse> {
  const reqHeaders = await headers();
  const session = await auth.api.getSession({ headers: reqHeaders });
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (dbBackend() !== "d1") return notFound();
  const email = session.user.email ?? null;
  if (!readerV2On(await readFlags(), isOwner(email))) return notFound();
  const material = await getReadMaterialById(userId, materialId);
  if (!material) return notFound();
  const db = getD1() as unknown as D1Batch;
  const hash = await hashOf(material);
  // Saved for next time, so another site's link just answers without saving.
  if (!material.contentHash && !offSiteHeaders(reqHeaders)) {
    try {
      await saveContentHash(db, userId, String(material._id), hash);
    } catch (err) {
      console.error("read: content hash backfill failed", err);
    }
  }
  let loaded: Promise<{ book: ReaderBook; words: MaterialWords }> | null = null;
  const ref: BookRef = {
    userId,
    materialId: String(material._id),
    bookHash: hash,
    lang: wordLang(null, []),
  };
  const load = () =>
    (loaded ??= materialWords(material, userId).then((words) => {
      const book = readerBook(material.lines, words.book, hash);
      ref.lang = book.lang;
      return { book, words };
    }));
  return { userId, email, db, material, ref, load };
}

/** The request's JSON body (sendBeacon sends text/plain), or null. */
export async function bodyOf(req: Request): Promise<unknown> {
  try {
    const text = await req.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** A line range from ?from=&to=, clamped to the book. */
export function lineRange(url: URL, lineCount: number): [number, number] {
  const int = (v: string | null, d: number) => {
    const n = Number.parseInt(v ?? "", 10);
    return Number.isFinite(n) ? n : d;
  };
  const from = Math.max(0, Math.min(lineCount, int(url.searchParams.get("from"), 0)));
  const to = Math.max(from, Math.min(lineCount, int(url.searchParams.get("to"), lineCount)));
  return [from, to];
}

/** The user's word cards in the book's language, for familiarity (one query). */
export async function wordCtx(ctx: ReaderCtx): Promise<{ book: ReaderBook; w: WordContext }> {
  const { book, words } = await ctx.load();
  const rows = ctx.email ? await userWordCards(ctx.db, ctx.email, [book.lang]) : [];
  return {
    book,
    w: { idx: cardIndex(rows), stats: words.stats, lem: statsLemmas(words.stats) },
  };
}

/** A range's words, as the device sends them for the word review (≤ 400, strings capped). */
export function rangeWords(raw: unknown, own: (w: string) => boolean) {
  if (!Array.isArray(raw) || raw.length > 400) return null;
  const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : null);
  const out: {
    w: string;
    ex: string | null;
    term: string | null;
    reading: string | null;
    back: string | null;
  }[] = [];
  const seen = new Set<string>();
  for (const x of raw as Record<string, unknown>[]) {
    const w = x && typeof x === "object" ? str(x.w, 200) : null;
    // Only the book's own words: the book's list holds nothing else.
    if (!w || seen.has(w) || !own(w)) continue;
    seen.add(w);
    out.push({
      w,
      ex: str(x.ex, 1000),
      term: str(x.term, 200),
      reading: str(x.reading, 200),
      back: str(x.back, 1000),
    });
  }
  return out;
}

/** The book as the word review needs it: hash, title, language, lemmas. */
export async function bookCtxOf(ctx: ReaderCtx) {
  const { book, words } = await ctx.load();
  const own = new Set(words.stats.words.map(([w]) => w));
  return {
    book: {
      hash: book.hash,
      title: ctx.material.title,
      lang: book.lang,
      lem: statsLemmas(words.stats),
      names: new Set(words.stats.names),
      exampleOf: exampleFinder(ctx.material.lines),
      privateText: isVibeMaterial(ctx.material),
    },
    // A book word, or a phrase of the book's words (a phrase card: the same path as a word's).
    own: (w: string) => own.has(w) || bookPhrase(w, book.lang, (x) => own.has(x)),
    langs: book.langs,
  };
}

type BookCtxValue = Awaited<ReturnType<typeof bookCtxOf>>["book"];

/**
 * A book that mixes languages: its words grouped by their own language
 * (lib/read/lang-detect.ts langIn), each with the book as that language's
 * words need it. The primary language keeps the book's list ("book:<hash>");
 * another gets its own list of that language ("book:<hash>~<lang>"), so a
 * card is always made, matched and glossed in the word's language. A book
 * of one language is one group, as before.
 */
export function byLang(
  base: BookCtxValue,
  langs: readonly string[],
  words: RangeWord[],
): { book: BookCtxValue; words: RangeWord[] }[] {
  const groups = new Map<string, RangeWord[]>();
  for (const w of words) {
    const l = langIn(w.term || w.w, langs, base.lang);
    const g = groups.get(l);
    if (g) g.push(w);
    else groups.set(l, [w]);
  }
  return [...groups].map(([l, ws]) => ({ book: bookInLang(base, l), words: ws }));
}

/** The book as the word review needs it in one of its languages. */
export function bookInLang(base: BookCtxValue, lang: string): BookCtxValue {
  if (lang === base.lang) return base;
  return {
    ...base,
    hash: `${base.hash}~${lang}`,
    title: `${base.title} · ${lang}`,
    lang,
    lem: null,
    names: new Set(),
  };
}
