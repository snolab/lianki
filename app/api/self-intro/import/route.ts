import { headers } from "next/headers";
import { auth } from "@/auth";
import { readFlags } from "@/lib/flags-store";
import { isDev } from "@/lib/permissions";
import { workersAiComplete } from "@/lib/read/gloss-server";
import { isWorkersAiConfigured } from "@/lib/workers-ai";
import { handleImport } from "@/lib/self-intro/import-handler";

export const dynamic = "force-dynamic";

/**
 * POST /api/self-intro/import → {facts}. The material is processed in this
 * request's memory and never stored (lib/self-intro/import-handler.ts).
 */
export async function POST(req: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  const u = session?.user;
  const user = u?.id && u.email ? { id: u.id, email: u.email } : null;
  return handleImport(req, {
    user,
    owner: isDev(user?.email),
    flags: user ? await readFlags() : {},
    configured: isWorkersAiConfigured(),
    complete: workersAiComplete,
  });
}
