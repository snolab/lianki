import { headers } from "next/headers";
import { auth } from "@/auth";
import { readFlags } from "@/lib/flags-store";
import { walletDb } from "@/lib/payments/wallet-db";
import { isDev } from "@/lib/permissions";
import { workersAiComplete } from "@/lib/read/gloss-server";
import { isWorkersAiConfigured } from "@/lib/workers-ai";
import { handleImport, handleImportQuota, type ImportDeps } from "@/lib/self-intro/import-handler";
import { storedFileReader } from "@/lib/import/stored-read";

export const dynamic = "force-dynamic";

async function deps(): Promise<ImportDeps> {
  const session = await auth.api.getSession({ headers: await headers() });
  const u = session?.user;
  const user = u?.id && u.email ? { id: u.id, email: u.email } : null;
  return {
    user,
    owner: isDev(user?.email),
    flags: user ? await readFlags() : {},
    configured: isWorkersAiConfigured(),
    complete: workersAiComplete,
    // The credit wallet (the call is paid from it).
    db: walletDb(),
    // The user's own stored /self-intro files (the file store, lib/import/files.ts).
    readFile: storedFileReader("self-intro"),
  };
}

/**
 * POST /api/self-intro/import {text, fileIds, locale} → {facts}: what was
 * typed plus the user's own stored files, read here into the request only
 * (lib/self-intro/import-handler.ts). The files stay in their file store.
 */
export async function POST(req: Request) {
  return handleImport(req, await deps());
}

/** GET /api/self-intro/import → {on, available, need, have}: may this user start an analysis? */
export async function GET() {
  return handleImportQuota(await deps());
}
