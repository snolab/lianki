import { NextResponse } from "next/server";
import { authEmailOrToken } from "@/lib/authEmailOrToken";
import { isOwner } from "@/lib/owner";
import {
  PARTNER_TICKET_AUD,
  PARTNER_TICKET_HEADER,
  importTicketKey,
  signSttTicket,
} from "@/lib/stt-ticket";

/**
 * A 60 s, single-use ticket for the Learning Partner on another site
 * (docs/dev-debug-widget.md, "On every site"). The userscript fetches it with
 * GM_xmlhttpRequest (its lianki.com session or `lk:token`), then offers it to
 * lianki-push in Sec-WebSocket-Protocol, never in the URL. lianki-push checks
 * it with the public key and binds that socket to the owner's chat thread:
 * chat only, never eval, never a pairing.
 *
 * Owner only, as the hot widget: 404 for anyone else. 503 while the signing
 * key (STT_TICKET_KEY, shared with the STT tickets under another audience)
 * is not set. POST, so nothing caches or prefetches it.
 */
export const POST = async (req: Request) => {
  if (req.headers.get(PARTNER_TICKET_HEADER) !== "1")
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  const email = await authEmailOrToken(req);
  if (!isOwner(email)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const raw = process.env.STT_TICKET_KEY;
  if (!raw) return NextResponse.json({ error: "Partner tickets are off" }, { status: 503 });
  let key: CryptoKey;
  try {
    key = await importTicketKey(raw);
  } catch {
    return NextResponse.json({ error: "Partner tickets are off" }, { status: 503 });
  }
  const { ticket, exp } = await signSttTicket(key, { aud: PARTNER_TICKET_AUD });
  return NextResponse.json({ ticket, exp }, { headers: { "cache-control": "no-store" } });
};
