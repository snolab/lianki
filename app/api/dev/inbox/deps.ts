import { authUserOrNull } from "@/app/signInEmail";
import { isOwner } from "@/lib/owner";
import { getBlobs, getD1 } from "@/lib/d1";
import { rateLimiter } from "@/lib/debug-session";
import { INBOX } from "@/lib/inbox/config";
import type { InboxBucket, InboxDeps } from "@/lib/inbox/handlers";
import type { InboxDb } from "@/lib/inbox/store";

/** Uploads per minute, per isolate (lib/inbox/config.ts). */
const allow = rateLimiter(INBOX.uploadsPerMinute, 60_000);

/** The inbox routes' dependencies: the signed-in user (owner or not), D1, R2 lianki-blobs. */
export const inboxDeps: InboxDeps = {
  who: async () => {
    const u = await authUserOrNull();
    return u?.id && u.email ? { id: u.id, email: u.email, owner: isOwner(u.email) } : null;
  },
  db: () => getD1() as unknown as InboxDb,
  bucket: () => getBlobs() as unknown as InboxBucket,
  allow,
};
