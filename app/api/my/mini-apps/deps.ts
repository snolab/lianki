import { getCloudflareContext } from "@opennextjs/cloudflare";
import { authUserOrNull } from "@/app/signInEmail";
import { cfg } from "@/lib/config-store";
import { dbBackend, getBlobs, getD1 } from "@/lib/d1";
import { flagIn } from "@/lib/flags";
import { readFlags } from "@/lib/flags-store";
import { createMiniDeps } from "@/lib/mini-apps/deps";
import { isDev } from "@/lib/permissions";
import { notifyTokensRevoked } from "@/lib/push-chat-tokens";

type Fetcher = { fetch(url: string, init?: RequestInit): Promise<Response> };

/** The real bindings (docs/mini-apps.md). D1 only: on the Mongo rollback copy, every route is 404. */
export const miniDeps = createMiniDeps({
  user: authUserOrNull,
  isDev: (email) => isDev(email),
  on: async () => dbBackend() === "d1" && flagIn(await readFlags(), "mini-apps"),
  db: getD1,
  bucket: getBlobs,
  value: cfg,
  push: () => {
    try {
      return (getCloudflareContext().env as unknown as { PUSH?: Fetcher }).PUSH ?? null;
    } catch {
      return null;
    }
  },
  revoked: (ids) => notifyTokensRevoked({ ids }),
  secret: () => process.env.AUTH_SECRET,
});
