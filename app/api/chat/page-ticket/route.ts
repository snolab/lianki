import { authUserOrNull } from "@/app/signInEmail";
import { cfg } from "@/lib/config-store";
import { dbBackend, getD1 } from "@/lib/d1";
import type { D1Like } from "@/lib/d1/types";
import { readFlags } from "@/lib/flags-store";
import { pageChatTicket } from "@/lib/page-chat-ticket";
import { threadHashKeyFromJwk } from "@/lib/li-thread";
import { isDev } from "@/lib/permissions";
import { refreshPermissions } from "@/lib/permission-store";
import { checkRateLimit } from "@/lib/rateLimit";
import { importTicketKey } from "@/lib/stt-ticket";

export const dynamic = "force-dynamic";

/**
 * Session-only site-bound chat for page-realm portable Li
 * (docs/userscript-li-chat.md, M2): lib/page-chat-ticket.ts.
 */
export const POST = (req: Request) =>
  pageChatTicket(req, {
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
      checkRateLimit(`li-ticket:${userId}`, {
        windowMs: 60_000,
        max: await cfg("chat.pillTicketsPerMinute"),
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
