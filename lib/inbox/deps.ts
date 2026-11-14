import type { InboxBucket, InboxDeps } from "./handlers";
import type { InboxDb } from "./store";
import { createAccountUploadLimiter } from "./rate";

type QuotaKey =
  | "inbox.maxFileBytes"
  | "inbox.maxDayBytes"
  | "inbox.maxStoredBytes"
  | "inbox.uploadsPerMinute";
/** Server adapters supplied by the route; no global auth or DB in the rules. */
export function createInboxDeps(source: {
  user: () => Promise<{ id: string; email?: string | null } | null>;
  db: () => unknown;
  bucket: () => unknown;
  value: (key: QuotaKey) => Promise<number>;
}): InboxDeps {
  return {
    who: async () => {
      const user = await source.user();
      return user?.id && user.email ? { id: user.id, email: user.email, owner: false } : null;
    },
    db: () => source.db() as InboxDb,
    bucket: () => source.bucket() as InboxBucket,
    limits: async () => {
      const [maxFileBytes, maxDayBytes, maxStoredBytes, uploadsPerMinute] = await Promise.all([
        source.value("inbox.maxFileBytes"),
        source.value("inbox.maxDayBytes"),
        source.value("inbox.maxStoredBytes"),
        source.value("inbox.uploadsPerMinute"),
      ]);
      return { maxFileBytes, maxDayBytes, maxStoredBytes, uploadsPerMinute };
    },
    allow: createAccountUploadLimiter(),
  };
}
