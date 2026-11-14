import { authUserOrNull } from "@/app/signInEmail";
import { getBlobs, getD1 } from "@/lib/d1";
import { cfg } from "@/lib/config-store";
import { createInboxDeps } from "@/lib/inbox/deps";
export const inboxDeps = createInboxDeps({
  user: authUserOrNull,
  db: getD1,
  bucket: getBlobs,
  value: cfg,
});
