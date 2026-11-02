import { NextResponse } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { isOwner } from "@/lib/owner";
import { importTicketKey, signSttTicket } from "@/lib/stt-ticket";

/**
 * A 60 s, single-use ticket for the owner's local STT server over the public
 * tunnel (wss://stt.lianki.com; lib/stt-ticket.ts, docs/local-stt.md). Owner
 * session only; 404 for anyone else, as every /api/dev route. 503 when the
 * STT_TICKET_KEY secret is not set. POST, so nothing caches or prefetches it.
 */
export const POST = async () => {
  const user = await authUserOrNull();
  if (!isOwner(user?.email)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const raw = process.env.STT_TICKET_KEY;
  if (!raw) return NextResponse.json({ error: "STT tickets are off" }, { status: 503 });
  let key: CryptoKey;
  try {
    key = await importTicketKey(raw);
  } catch {
    return NextResponse.json({ error: "STT tickets are off" }, { status: 503 });
  }
  const { ticket, exp } = await signSttTicket(key);
  return NextResponse.json({ ticket, exp }, { headers: { "cache-control": "no-store" } });
};
