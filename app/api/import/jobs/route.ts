import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend, getD1 } from "@/lib/d1";
import { readFlags } from "@/lib/flags-store";
import { isDev } from "@/lib/permissions";
import { handleImportJobs } from "@/lib/import/words-handler";

export const dynamic = "force-dynamic";

/** GET /api/import/jobs: the user's latest import jobs (docs/import-material.md). */
export async function GET() {
  const u = await authUserOrNull();
  const user = u?.email ? { email: u.email } : null;
  return handleImportJobs({
    user,
    owner: isDev(user?.email),
    flags: user ? await readFlags() : {},
    db: dbBackend() === "d1" ? getD1() : null,
  });
}
