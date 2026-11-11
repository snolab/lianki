import { headers } from "next/headers";
import { auth } from "@/auth";
import { readFlags } from "@/lib/flags-store";
import { walletDb } from "@/lib/payments/wallet-db";
import { isDev } from "@/lib/permissions";
import type { Complete } from "@/lib/read/gloss-server";
import { isWorkersAiConfigured, workersAiOpenAI } from "@/lib/workers-ai";
import { storedFileReader } from "@/lib/import/stored-read";
import { d1ChunkCache } from "@/lib/import/chunk-cache";
import { dbBackend, getD1 } from "@/lib/d1";
import {
  AI_IMPORT,
  handleAiConvert,
  handleAiQuota,
  type AiImportDeps,
} from "@/lib/import/ai-convert";

export const dynamic = "force-dynamic";

/** Workers AI, with room for a long answer (a chunk's rows take up to a minute). */
const complete: Complete = async (body) =>
  (await workersAiOpenAI().chat.completions.create(body as never, {
    timeout: AI_IMPORT.callTimeoutMs,
  })) as Awaited<ReturnType<Complete>>;

const readFile: AiImportDeps["readFile"] = storedFileReader("import");

/** The signed-in user, the gate's inputs, the model, the credit wallet and their stored files. */
async function deps(): Promise<AiImportDeps> {
  const session = await auth.api.getSession({ headers: await headers() });
  const u = session?.user;
  const user = u?.id && u.email ? { id: u.id, email: u.email } : null;
  return {
    user,
    owner: isDev(user?.email),
    flags: user ? await readFlags() : {},
    configured: isWorkersAiConfigured(),
    complete,
    // The credit wallet (the calls are paid from it); the material is stored nowhere new.
    db: walletDb(),
    readFile,
    // Paid chunks kept per file, so a run stopped for want of credits resumes.
    cache: dbBackend() === "d1" ? d1ChunkCache(getD1()) : null,
  };
}

/** GET /api/import/ai → {on, available}: is the AI conversion offered to this user (gate + credits)? */
export async function GET() {
  return handleAiQuota(await deps());
}

/** POST /api/import/ai {fileId, locale} → {csv, rows, truncated, charged} (lib/import/ai-convert.ts). */
export async function POST(req: Request) {
  return handleAiConvert(req, await deps());
}
