// GET → {days}, PUT {days}: the optional number of days after which this user's
// /vibe docs are deleted; null is off, the default (docs/vibe.md, "Keeping"). The
// daily sweep reads it. Same gate as the rest.
import { NOT_FOUND, settingsGetReply, settingsPutReply } from "@/lib/vibe/api";
import { reply, vibeGate, vibeWrite } from "@/lib/vibe/route";

export async function GET() {
  const g = await vibeGate();
  return reply(g ? await settingsGetReply(g.db, g.userId) : NOT_FOUND);
}

export const PUT = (req: Request) =>
  vibeWrite(req, 1024, ({ db, userId }, body) => settingsPutReply(db, userId, body, Date.now()));
