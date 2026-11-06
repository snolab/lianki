// POST /api/vibe/[id]/translate {text, to, from} → {text, cached}: one finished line
// of the user's own conversation (docs/vibe.md, "Translations"). 404 gate · 409
// paused · 400 not one of its lines · 429 over the limit · 502 the model failed ·
// 503 not configured. Logs never carry the text.
import { translateLineReply } from "@/lib/vibe/api";
import { vibeWrite } from "@/lib/vibe/route";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return vibeWrite(req, 16 * 1024, ({ db, userId }, body) =>
    translateLineReply(db, userId, id, body, Date.now()),
  );
}
