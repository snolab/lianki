import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend, getD1 } from "@/lib/d1";
import type { D1Like } from "@/lib/d1/types";
import { isDev } from "@/lib/permissions";
import { refreshOwners } from "@/lib/owner-store";
import { refreshPermissions } from "@/lib/permission-store";
import { partnerTicket } from "@/lib/partner-ticket-auth";
import { importTicketKey } from "@/lib/stt-ticket";

/**
 * A 60 s, single-use ticket for the Learning Partner on another site
 * (docs/dev-debug-widget.md, "On every site"). The userscript fetches it with
 * GM_xmlhttpRequest (its lianki.com session, or `lk:token` when that token
 * holds chat:read and chat:write), then offers it to lianki-push in
 * Sec-WebSocket-Protocol, never in the URL. lianki-push checks it with the
 * public key and binds that socket to the owner's chat thread: chat only,
 * never eval, never a pairing.
 *
 * Owner only, as the hot widget: 404 for anyone else, and for a token without
 * the chat permissions (a `study` token is cards and settings, never a chat
 * ticket; lib/partner-ticket-auth.ts). 503 while the signing key
 * (STT_TICKET_KEY, shared with the STT tickets under another audience) is not
 * set. POST, so nothing caches or prefetches it.
 */
export const POST = (req: Request) =>
  partnerTicket(req, {
    backend: dbBackend,
    d1: () => getD1() as unknown as D1Like,
    sessionEmail: async () => (await authUserOrNull())?.email ?? null,
    isOwner: async (email) => {
      // A bearer token reads no session, so nothing has refreshed the owner list yet.
      await Promise.all([refreshOwners(), refreshPermissions()]);
      return isDev(email);
    },
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
