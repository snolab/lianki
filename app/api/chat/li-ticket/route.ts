import { authUserOrNull } from "@/app/signInEmail";
import { cfg } from "@/lib/config-store";
import { dbBackend, getD1 } from "@/lib/d1";
import type { D1Like } from "@/lib/d1/types";
import { readFlags } from "@/lib/flags-store";
import { liTicket } from "@/lib/li-ticket-route";
import { isDev } from "@/lib/permissions";
import { refreshPermissions } from "@/lib/permission-store";
import { checkRateLimit } from "@/lib/rateLimit";
import { importTicketKey } from "@/lib/stt-ticket";

export const dynamic = "force-dynamic";

/**
 * The account-scoped Li chat ticket for the userscript pill
 * (docs/userscript-li-chat.md, M2): lib/li-ticket-route.ts.
 */
export const POST = (req: Request) =>
  liTicket(req, {
    backend: dbBackend,
    d1: () => getD1() as unknown as D1Like,
    sessionUser: async () => {
      const u = await authUserOrNull();
      return u?.id && u.email ? { id: u.id, email: u.email } : null;
    },
    isDev: async (email) => {
      // A bearer token reads no session, so nothing has refreshed the grants yet.
      await refreshPermissions();
      return isDev(email);
    },
    flags: () => readFlags(),
    allow: async (userId) =>
      checkRateLimit(`li-ticket:${userId}`, {
        windowMs: 60_000,
        max: await cfg("chat.pillTicketsPerMinute"),
      }).allowed,
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
