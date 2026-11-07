import { getD1 } from "@/lib/d1";
import { chatTicketResponse } from "@/lib/box-oauth/chat-ticket";
import type { BoxDb } from "@/lib/box-oauth/store";
import { checkRateLimit } from "@/lib/rateLimit";
import { BOX_CHAT_TICKET_AUD, importTicketKey, signSttTicket } from "@/lib/stt-ticket";

export const dynamic = "force-dynamic";

/** Tickets per box per minute: one per connect, and a page reconnects on events only. */
const PER_MINUTE = 20;

/**
 * The chat ticket of the owner's box (lib/box-oauth/chat-ticket.ts,
 * docs/box-oauth.md "Chat on the owner's box"). POST, box:chat tokens only.
 */
export const POST = (req: Request) => {
  let db: BoxDb;
  try {
    db = getD1() as unknown as BoxDb;
  } catch {
    // Off the D1 backend there are no boxes.
    return new Response(null, { status: 404 });
  }
  return chatTicketResponse(req.headers, {
    secret: process.env.AUTH_SECRET,
    db,
    allow: (clientId) =>
      checkRateLimit(`box-chat-ticket:${clientId}`, { windowMs: 60_000, max: PER_MINUTE }).allowed,
    sign: async ({ org, cid }) => {
      const raw = process.env.STT_TICKET_KEY;
      if (!raw) return null;
      return signSttTicket(await importTicketKey(raw), { aud: BOX_CHAT_TICKET_AUD, org, cid });
    },
  });
};
