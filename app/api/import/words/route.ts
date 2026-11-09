import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend, getD1 } from "@/lib/d1";
import { readFlags } from "@/lib/flags-store";
import { isDev } from "@/lib/permissions";
import { handleWordImport } from "@/lib/import/words-handler";

export const dynamic = "force-dynamic";

/**
 * POST /api/import/words: a .txt/.csv word list → preview counts, or a new
 * /words list (docs/import-material.md, M1; lib/import/words-handler.ts).
 */
export async function POST(req: Request) {
  const u = await authUserOrNull();
  const user = u?.email ? { email: u.email } : null;
  return handleWordImport(req, {
    user,
    owner: isDev(user?.email),
    flags: user ? await readFlags() : {},
    db: dbBackend() === "d1" ? getD1() : null,
  });
}
