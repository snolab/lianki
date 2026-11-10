import { dbBackend } from "@/lib/d1";
import { readFlags } from "@/lib/flags-store";
import { flagIn } from "@/lib/flags";
import { isDev } from "@/lib/permissions";
import { importAnyOn } from "@/lib/import/words-handler";
import type { ImportFilesDeps } from "@/lib/import/files";
import { inboxDeps } from "@/app/api/dev/inbox/deps";
import { getBlobs, getD1 } from "@/lib/d1";
import { dropChunks } from "@/lib/import/chunk-cache";
import { booksMineOn } from "@/lib/books/gate";
import { coverKey } from "@/lib/books/own-import";

/**
 * The user's stored files: the chat inbox's storage (D1 + R2 lianki-blobs,
 * its caps and rate limit), for any signed-in user a gate lets in: the Import
 * panel's own (`import.any`, importAnyOn) for its sources, `books.mine` for an
 * own book on /books (source `books`), either for a listing of every source.
 */
export const importFilesDeps = (): ImportFilesDeps => ({
  ...inboxDeps,
  on: async (who, source = "import") => {
    const flags = await readFlags();
    const dev = isDev(who.email);
    // His voiceprint's recordings: the same gate as the features in his account.
    const voiceprint = dev && flagIn(flags, "stt.voiceprint-cloud");
    if (source === "books") return booksMineOn(flags, dev);
    if (source === "voiceprint") return voiceprint;
    if (source === "any") return importAnyOn(flags, dev) || booksMineOn(flags, dev) || voiceprint;
    return importAnyOn(flags, dev);
  },
  available: dbBackend() === "d1",
  // What was derived from a deleted file goes with it: cached AI chunks, a book's cover.
  dropDerived: async (userId, fileId) => {
    await dropChunks(getD1(), userId, fileId);
    await getBlobs()
      .delete(coverKey(userId, fileId))
      .catch(() => {});
  },
});
