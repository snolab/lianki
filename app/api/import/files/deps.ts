import { dbBackend } from "@/lib/d1";
import { readFlags } from "@/lib/flags-store";
import { isDev } from "@/lib/permissions";
import { importAnyOn } from "@/lib/import/words-handler";
import type { ImportFilesDeps } from "@/lib/import/files";
import { inboxDeps } from "@/app/api/dev/inbox/deps";

/**
 * The Import panel's stored files: the chat inbox's storage (D1 + R2
 * lianki-blobs, its caps and rate limit), behind the Import panel's own gate
 * (`import.any`, importAnyOn), for any signed-in user it lets in.
 */
export const importFilesDeps = (): ImportFilesDeps => ({
  ...inboxDeps,
  on: async (who) => importAnyOn(await readFlags(), isDev(who.email)),
  available: dbBackend() === "d1",
});
