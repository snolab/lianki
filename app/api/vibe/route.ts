// POST /api/vibe {consent: true, otherLang, title} → {id}: the /vibe consent
// screen's start button (docs/vibe.md). 404 unless `read.vibe` is on and this is
// the owner, with no owner bypass of the flag.
import { startReply } from "@/lib/vibe/api";
import { vibeWrite } from "@/lib/vibe/route";

export const POST = (req: Request) =>
  vibeWrite(req, 4096, ({ db, userId }, body) => startReply(db, userId, body, Date.now()));
