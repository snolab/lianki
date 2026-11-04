// POST /api/books/import { book: "<lang>/<slug>" } — import a /books catalogue
// book as the user's own book (lib/books/import.ts); they read it in /read.
// Importing it again answers the book they already have (`existing: true`).
//
// Only catalogue entries: the client names an entry, never a URL; the server
// fetches that entry's own file from an allowed host (lib/books/source.ts),
// through the shared R2 cache. Rate-limited per user (each new import parses a
// whole book). Gate: a session, D1, and `books.catalogue` or the owner; and
// the book must be public domain where the viewer is (lib/books/terms.ts).

import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { dbBackend, getD1 } from "@/lib/d1";
import { readFlags } from "@/lib/flags-store";
import { isOwner } from "@/lib/owner";
import { hit } from "@/lib/security/throttle";
import { findReadMaterialBySource, saveReadMaterial } from "@/lib/getReadMaterialsCollection";
import { bookVisibleIn, catalogueBook } from "@/lib/books/catalogue";
import { ruleYear, viewerCountry } from "@/lib/books/viewer";
import { booksOn } from "@/lib/books/gate";
import { importCatalogueBook } from "@/lib/books/import";
import { r2SourceCache } from "@/lib/books/cache-r2";
import { BookSourceFail } from "@/lib/books/source";

const fail = (error: string, status: number) => NextResponse.json({ error }, { status });

/** New imports per user per window (D1 counter); opening one already imported is not counted. */
const RATE = { windowMs: 10 * 60_000, max: 20 };

const STATUS = { "fetch-failed": 502, "too-large": 413, "no-text": 422 } as const;

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  const userId = session?.user?.id;
  if (!userId) return fail("Unauthorized", 401);
  if (dbBackend() !== "d1") return fail("Not found", 404);
  const flags = await readFlags();
  if (!booksOn(flags, isOwner(session.user.email ?? null))) return fail("Not found", 404);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("bad-book", 400);
  }
  const book = catalogueBook((body as { book?: unknown } | null)?.book);
  if (!book) return fail("bad-book", 400);
  // The admission rule, server-side (lib/books/terms.ts): public domain in the
  // work's country, the viewer's country and the US, or no import.
  const country = viewerCountry(request.headers);
  if (!bookVisibleIn(book, country, ruleYear())) {
    return NextResponse.json(
      {
        error: "not-public-domain-here",
        message: `This book is not in the public domain in ${country ?? "your country"} under our rule, so it cannot be added there.`,
      },
      { status: 451 },
    );
  }

  const find = async (uid: string, key: string) => {
    const m = await findReadMaterialBySource(uid, key);
    return m ? { id: String(m._id) } : null;
  };
  // Opening a book already imported costs nothing: answer before the limit.
  const prev = await find(userId, `preset:${book.lang}/${book.slug}`);
  if (prev) return NextResponse.json({ id: prev.id, existing: true });

  const rate = await hit(getD1(), `books-import:${userId}`, RATE);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "rate-limited" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rate.retryAfterMs / 1000)) } },
    );
  }

  try {
    const r = await importCatalogueBook(userId, book, {
      find,
      save: async (uid, title, content, lines, hash, key) => {
        const m = await saveReadMaterial(uid, title, content, lines, hash, key);
        return { id: String(m._id) };
      },
      cache: r2SourceCache(),
    });
    console.log(
      "books.import",
      JSON.stringify({ book: `${book.lang}/${book.slug}`, cached: r.cached }),
    );
    return NextResponse.json(r);
  } catch (err) {
    if (err instanceof BookSourceFail) return fail(err.code, STATUS[err.code]);
    console.error("books: import failed", err);
    return fail("fetch-failed", 502);
  }
}
