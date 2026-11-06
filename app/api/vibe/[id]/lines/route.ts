// POST /api/vibe/[id]/lines {from, lines} → {next, material, langs}: text heard,
// onto the end of the user's own transcript (docs/vibe.md). Text only: no route
// here ever takes audio. 404 gate · 409 paused or stopped · 413 full. An open
// reader is told through lianki-push.
import { linesReply } from "@/lib/vibe/api";
import { vibeWrite } from "@/lib/vibe/route";
import { tellReaders } from "@/lib/read/tell-readers";
import { routeLimit } from "@/lib/security/route-guard";

/** Batches per user per window, counted per isolate: a final every second or so at most. */
const RATE = { windowMs: 60_000, max: 240 };

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return vibeWrite(req, 256 * 1024, async ({ db, userId }, body) => {
    if (!(await routeLimit(`vibe-lines:${userId}`, RATE, null)).allowed)
      return { status: 429, body: { error: "rate-limited" } };
    const r = await linesReply(db, userId, id, body, Date.now());
    if (r.appended) tellReaders(userId, { book: r.appended.material, hash: r.appended.hash });
    return { status: r.status, body: r.body };
  });
}
