import { headers } from "next/headers";
import { auth } from "@/auth";
import { readFlags } from "@/lib/flags-store";
import { isOwner } from "@/lib/owner";
import { workersAiComplete } from "@/lib/read/gloss-server";
import { isWorkersAiConfigured } from "@/lib/workers-ai";
import { handleFollowup } from "@/lib/self-intro/import-handler";

export const dynamic = "force-dynamic";

/**
 * POST /api/self-intro/followup → {facts, question}: one turn of the facts
 * step's follow-up questions; nothing is stored (lib/self-intro/followup.ts).
 */
export async function POST(req: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  const u = session?.user;
  const user = u?.id && u.email ? { id: u.id, email: u.email } : null;
  return handleFollowup(req, {
    user,
    owner: isOwner(user?.email),
    flags: user ? await readFlags() : {},
    configured: isWorkersAiConfigured(),
    complete: workersAiComplete,
  });
}
