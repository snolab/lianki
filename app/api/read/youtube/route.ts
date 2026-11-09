// POST /api/read/youtube { url, lyrics, title? } — a YouTube song into /read
// (docs/youtube-song-examples.md, M1): one passage per sung line, each with
// its clip [t0, t1] in BookMeta.yt. The reader plays a line in YouTube's own
// embedded player; nothing from YouTube is fetched, downloaded or stored here
// but the video id the link names.
//
// Gate: signed in, D1, and `read.youtube-songs` or the owner (else 404).
// Same-origin JSON only; rate-limited. The lyrics are the user's own text,
// stored in their account only (never a shared cache or a public page),
// capped at 64 KB and 500 lines. The same video again updates that song in place.

import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { dbBackend, getD1 } from "@/lib/d1";
import { readFlags } from "@/lib/flags-store";
import { isDev } from "@/lib/permissions";
import { hit } from "@/lib/security/throttle";
import { sameOriginJsonPost } from "@/lib/security/same-origin";
import { cappedJsonError, readJsonCapped } from "@/lib/security/route-guard";
import {
  findReadMaterialBySource,
  replaceReadMaterialText,
  saveReadMaterial,
} from "@/lib/getReadMaterialsCollection";
import { bookMetaOf, checkBook } from "@/lib/read/book";
import { checkShape, type TextShape } from "@/lib/read/prep";
import { detectLangs, primaryLang, toRuns } from "@/lib/read/lang-detect";
import { cleanTitle } from "@/lib/read/title";
import { bookHash } from "@/lib/read/units";
import { ytSongsOn } from "@/lib/yt-songs/gate";
import { songBook, songSourceKey } from "@/lib/yt-songs/song";
import { parseTimedText, videoIdOf, YT_LIMITS } from "@/lib/yt-songs/timed-text";

const fail = (error: string, status: number) => NextResponse.json({ error }, { status });

/** Songs saved per user per window. */
const RATE = { windowMs: 10 * 60_000, max: 30 };

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  const userId = session?.user?.id;
  if (!userId) return fail("Unauthorized", 401);
  if (dbBackend() !== "d1") return fail("Not found", 404);
  if (!ytSongsOn(await readFlags(), isDev(session.user.email))) return fail("Not found", 404);
  if (!sameOriginJsonPost(request)) return fail("Forbidden", 403);

  // The lyrics' cap plus room for the link, the title and JSON escapes.
  const read = await readJsonCapped(request, YT_LIMITS.maxBytes * 2 + 4096);
  if (!read.ok) return cappedJsonError(read.status);
  const body = (read.value ?? {}) as { url?: unknown; lyrics?: unknown; title?: unknown };

  const v = typeof body.url === "string" ? videoIdOf(body.url) : null;
  if (!v) return fail("bad-url", 400);
  if (typeof body.lyrics !== "string") return fail("empty", 400);
  const parsed = parseTimedText(body.lyrics);
  if (!parsed.ok) return fail(parsed.error, parsed.error.startsWith("too-") ? 413 : 400);

  const rate = await hit(getD1(), `read-youtube:${userId}`, RATE);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "rate-limited" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rate.retryAfterMs / 1000)) } },
    );
  }

  const title = cleanTitle(body.title) ?? parsed.title ?? `YouTube ${v}`;
  const { book, yt } = songBook(v, title, parsed.lines);
  const checked = checkBook(book);
  if (!checked.ok) return fail(checked.error === "too-much-text" ? "too-large" : "empty", 400);
  const lines = checked.book.lines;

  // Lyrics often mix languages: each line its own, as /vibe does.
  const langs = detectLangs(lines);
  const runs = new Set(langs).size > 1 ? toRuns(langs) : undefined;
  // Sung lines are not a raw transcript: never offered the polish.
  const shape = checkShape({
    v: 1,
    raw: false,
    mixed: new Set(langs).size > 1,
    langs: [...new Set(langs)],
    signals: {},
  }) as TextShape;
  const meta = bookMetaOf(
    { ...checked.book, lang: primaryLang(lines), ...(runs ? { langs: runs } : {}) },
    { source: "youtube", shape, yt },
  );
  const content = JSON.stringify(meta);
  const hash = await bookHash(lines);
  const key = songSourceKey(v);

  const prev = await findReadMaterialBySource(userId, key);
  if (prev) {
    const id = String(prev._id);
    await replaceReadMaterialText(userId, id, title, lines, content, hash);
    return NextResponse.json({ id, lineCount: lines.length, updated: true });
  }
  const material = await saveReadMaterial(userId, title, content, lines, hash, key);
  return NextResponse.json({ id: String(material._id), lineCount: lines.length, updated: false });
}
