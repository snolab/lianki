// POST /api/books/resolve { url } — what the paste-link box and each search
// result show before an import: the work's entry and whether the admission
// rule lets this viewer add it, or the reason it cannot (a fact the source
// does not state, a translation, not public domain where they are…).
// Server-side only: the client sends the link, the server reads the host's
// own metadata (lib/books/lookup.ts). Rate-limited per user.

import { NextRequest, NextResponse } from "next/server";
import { r2SourceCache } from "@/lib/books/cache-r2";
import { booksApiUser, booksRate, fail } from "@/lib/books/api-gate";
import { resolveLink } from "@/lib/books/lookup";
import { d1SharedStore } from "@/lib/books/shared";
import { ruleYear, viewerCountry } from "@/lib/books/viewer";
import { BookSourceFail } from "@/lib/books/source";
import { ownedPresets } from "@/lib/books/owned";
import { bookKey } from "@/lib/books/catalogue";

/** Checks per user per window: each may read a host's metadata (cached after the first). */
const RATE = { windowMs: 10 * 60_000, max: 120 };

export async function POST(request: NextRequest) {
  const user = await booksApiUser();
  if (user instanceof NextResponse) return user;
  let body: { url?: unknown } | null = null;
  try {
    body = (await request.json()) as { url?: unknown } | null;
  } catch {
    return fail("bad-link", 400);
  }
  const limited = await booksRate("resolve", user.userId, RATE);
  if (limited) return limited;
  const country = viewerCountry(request.headers);
  try {
    const r = await resolveLink(body?.url, country, ruleYear(), {
      shared: d1SharedStore(),
      cache: r2SourceCache(),
    });
    const v = r.verdict;
    if (!v.ok)
      return NextResponse.json({
        ok: false,
        reason: v.reason,
        ...(v.detail ? { detail: v.detail } : {}),
        ...(v.facts
          ? { title: v.facts.title, author: v.facts.author, page: v.facts.source.page }
          : {}),
        country,
      });
    const owned = (await ownedPresets(user.userId))[bookKey(v.book)];
    return NextResponse.json({
      ok: true,
      curated: v.curated,
      book: {
        key: bookKey(v.book),
        title: v.book.title,
        author: v.book.author,
        lang: v.book.lang,
        firstPublicationYear: v.book.firstPublicationYear,
        page: v.book.source.page,
        site: v.book.source.name,
        licence: v.book.licence,
      },
      ...(owned ? { ownedId: owned } : {}),
    });
  } catch (err) {
    if (err instanceof BookSourceFail) return fail(err.code, 502);
    console.error("books: resolve failed", err);
    return fail("fetch-failed", 502);
  }
}
