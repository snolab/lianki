import { authUserOrNull } from "@/app/signInEmail";
import { cfg } from "@/lib/config-store";
import { dbBackend, getD1 } from "@/lib/d1";
import type { D1Like } from "@/lib/d1/types";
import { readFlags } from "@/lib/flags-store";
import { pageChatHttp } from "@/lib/page-chat-http-route";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { threadHashKeyFromJwk } from "@/lib/li-thread";
import { isDev } from "@/lib/permissions";
import { refreshPermissions } from "@/lib/permission-store";
import { checkRateLimit } from "@/lib/rateLimit";
import { importTicketKey } from "@/lib/stt-ticket";

export const dynamic = "force-dynamic";

/**
 * Cookie-only, site-bound chat transport for the static CSP fallback panel.
 */
export const POST = (req: Request) =>
  pageChatHttp(req, {
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
    backend: dbBackend,
    d1: () => getD1() as unknown as D1Like,
    sessionUser: async () => {
      const u = await authUserOrNull();
      return u?.id && u.email ? { id: u.id, email: u.email } : null;
    },
    isDev: async (email) => {
      // Resolve current grants before selecting the site-bound chat role.
      await refreshPermissions();
      return isDev(email);
    },
    flags: () => readFlags(),
    allow: async (userId) =>
      checkRateLimit(`page-chat-http:${userId}`, {
        windowMs: 60_000,
        max: await cfg("chat.pillTicketsPerMinute"),
      }).allowed,
    allowDictation: async (userId) =>
      checkRateLimit(`page-dictation-http:${userId}`, {
        windowMs: 60_000,
        max: (await cfg("chat.dictationPolicy")).requestsPerMinute,
      }).allowed,
    threadKey: () => threadHashKeyFromJwk(process.env.STT_TICKET_KEY),
    key: async () => {
      const raw = process.env.STT_TICKET_KEY;
      if (!raw) return null;
      try {
        return await importTicketKey(raw);
      } catch {
        return null;
      }
    },
  });
