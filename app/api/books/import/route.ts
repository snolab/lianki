// POST /api/books/import { book: "<lang>/<slug>" } or { url } — import a
// /books catalogue book as the user's own book (lib/books/import.ts); they
// read it in /read. Importing it again answers the book they already have
// (`existing: true`).
//
// `book` names a curated or shared entry. `url` is a book link from an
// allowed host (pasted, or a library search hit): the server resolves it to
// the work and the facts its source states (lib/books/lookup.ts), applies the
// admission rule, and a confirmed work not yet listed becomes a shared
// catalogue entry for everyone. Either way the server fetches the entry's own
// file from an allowed host (lib/books/source.ts), through the shared R2 cache. Rate-limited per user (each new import parses a
// whole book). Gate: a session, D1, and `library.catalogue` (or `dev`); and
// the book must be public domain where the viewer is (lib/books/terms.ts).

import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { dbBackend, getD1 } from "@/lib/d1";
import { readFlags } from "@/lib/flags-store";
import { isDev } from "@/lib/permissions";
import { hit } from "@/lib/security/throttle";
import { findReadMaterialBySource, saveReadMaterial } from "@/lib/getReadMaterialsCollection";
import { bookVisibleIn, catalogueBook, type CatalogueBook } from "@/lib/books/catalogue";
import { entryToImport, resolveLink } from "@/lib/books/lookup";
import { d1SharedStore } from "@/lib/books/shared";
import { ruleYear, viewerCountry } from "@/lib/books/viewer";
import { libraryOn } from "@/lib/books/gate";
import { importCatalogueBook } from "@/lib/books/import";
import { r2SourceCache } from "@/lib/books/cache-r2";
import { BookSourceFail } from "@/lib/books/source";

const fail = (error: string, status: number) => NextResponse.json({ error }, { status });

/** New imports per user per window (D1 counter); opening one already imported is not counted. */
const RATE = { windowMs: 10 * 60_000, max: 20 };

const STATUS = { "fetch-failed": 502, "too-large": 413, "no-text": 422 } as const;

const notHere = (country: string | null) =>
  `This book is not in the public domain in ${country ?? "your country"} under our rule, so it cannot be added there.`;

const rateLimited = (retryAfterMs: number) =>
  NextResponse.json(
    { error: "rate-limited" },
    { status: 429, headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) } },
  );

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  const userId = session?.user?.id;
  if (!userId) return fail("Unauthorized", 401);
  if (dbBackend() !== "d1") return fail("Not found", 404);
  const flags = await readFlags();
  if (!libraryOn(flags, isDev(session.user.email ?? null))) return fail("Not found", 404);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("bad-book", 400);
  }
  const req = (body ?? {}) as { book?: unknown; url?: unknown };
  const country = viewerCountry(request.headers);
  const shared = d1SharedStore();
  let book: CatalogueBook | null = null;
  // A new work from a link counts against the limit before it is added to the shared list.
  let counted = false;
  if (req.url !== undefined) {
    // A link: resolved to the work's entry, the rule applied to the facts its source states.
    const r = await resolveLink(req.url, country, ruleYear(), {
      shared,
      cache: r2SourceCache(),
    }).catch((err) => {
      console.error("books: resolve failed", err);
      return null;
    });
    if (!r) return fail("fetch-failed", 502);
    if (!r.verdict.ok)
      return r.verdict.reason === "not-public-domain-here"
        ? NextResponse.json(
            { error: "not-public-domain-here", message: notHere(country) },
            { status: 451 },
          )
        : NextResponse.json({ error: r.verdict.reason }, { status: 422 });
    book = r.verdict.curated ? r.verdict.book : null;
    if (!book) {
      // A new work: added to the shared catalogue only after the rate limit lets this import run.
      const limited = await hit(getD1(), `books-import:${userId}`, RATE);
      if (!limited.allowed) return rateLimited(limited.retryAfterMs);
      counted = true;
      try {
        book = await entryToImport(r, { shared, cache: r2SourceCache() });
      } catch (err) {
        if (err instanceof BookSourceFail) return fail(err.code, STATUS[err.code]);
        throw err;
      }
    }
  } else {
    const key = req.book;
    book = catalogueBook(key);
    if (!book && typeof key === "string" && /^[^/]{1,35}\/[^/]{1,200}$/.test(key)) {
      const [lang, slug] = key.split("/");
      book = await shared.byKey(lang, slug);
    }
  }
  if (!book) return fail("bad-book", 400);
  // The admission rule, server-side (lib/books/terms.ts): public domain in the
  // work's country, the viewer's country and the US, or no import.
  if (!bookVisibleIn(book, country, ruleYear())) {
    return NextResponse.json(
      {
        error: "not-public-domain-here",
        message: notHere(country),
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

  const rate = counted
    ? { allowed: true, retryAfterMs: 0 }
    : await hit(getD1(), `books-import:${userId}`, RATE);
  if (!rate.allowed) return rateLimited(rate.retryAfterMs);

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
