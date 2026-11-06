// POST /api/vibe/[id]/state {state: "running" | "paused" | "stopped"}: while it
// is not running the lines route refuses (docs/vibe.md). Stopped is final.
import { stateReply } from "@/lib/vibe/api";
import { vibeWrite } from "@/lib/vibe/route";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return vibeWrite(req, 1024, ({ db, userId }, body) => stateReply(db, userId, id, body));
}
