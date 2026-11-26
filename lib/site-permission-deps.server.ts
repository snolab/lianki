import { authUserOrNull } from "@/app/signInEmail";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { readFlags } from "./flags-store";
import { flagIn } from "./flags";
import { isDev } from "./permissions";
import { refreshPermissions } from "./permission-store";
import { importTicketKey } from "./stt-ticket";
import { checkRateLimit } from "./rateLimit";
import { cfg } from "./config-store";
import type { SitePermissionRouteDeps } from "./site-permission-route";
export function sitePermissionDeps(): SitePermissionRouteDeps {
  let userPromise: ReturnType<typeof authUserOrNull> | undefined;
  const user = () => (userPromise ??= authUserOrNull());
  return {
    user: async () => {
      const u = await user();
      return u?.id ? { id: u.id } : null;
    },
    key: async () => {
      try {
        return process.env.STT_TICKET_KEY
          ? await importTicketKey(process.env.STT_TICKET_KEY)
          : null;
      } catch {
        return null;
      }
    },
    push: () => {
      try {
        return (
          (
            getCloudflareContext().env as unknown as {
              PUSH?: { fetch(req: Request): Promise<Response> };
            }
          ).PUSH ?? null
        );
      } catch {
        return null;
      }
    },
    allow: async (sub) =>
      checkRateLimit("site-permission:" + sub, {
        windowMs: 60000,
        max: await cfg("chat.pillTicketsPerMinute"),
      }).allowed,
    chatOn: async () => {
      const [flags, u] = await Promise.all([readFlags(), user()]);
      if (!u?.email || !flagIn(flags, "ext.pill-chat")) return false;
      await refreshPermissions();
      return isDev(u.email) || flagIn(flags, "ext.pill-chat-users");
    },
  };
}
