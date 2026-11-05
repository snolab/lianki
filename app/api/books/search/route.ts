// GET /api/books/search?q=… — "到公版图书馆搜索": the server asks Project
// Gutenberg (Gutendex), each Wikisource site we read and Aozora Bunko's index
// (lib/books/search.ts), cached a day per query. Hits are links only: each is
// resolved (/api/books/resolve) before it can be imported. Rate-limited per user.

import { NextRequest, NextResponse } from "next/server";
import { r2SourceCache } from "@/lib/books/cache-r2";
import { booksApiUser, booksRate } from "@/lib/books/api-gate";
import { searchLibraries } from "@/lib/books/lookup";
import { d1SharedStore } from "@/lib/books/shared";

const RATE = { windowMs: 10 * 60_000, max: 30 };

export async function GET(request: NextRequest) {
  const user = await booksApiUser();
  if (user instanceof NextResponse) return user;
  const limited = await booksRate("search", user.userId, RATE);
  if (limited) return limited;
  try {
    const hits = await searchLibraries(request.nextUrl.searchParams.get("q"), {
      shared: d1SharedStore(),
      cache: r2SourceCache(),
    });
    return NextResponse.json({ hits });
  } catch (err) {
    console.error("books: search failed", err);
    return NextResponse.json({ error: "fetch-failed" }, { status: 502 });
  }
}
