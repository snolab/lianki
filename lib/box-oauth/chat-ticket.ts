/**
 * The Learning Partner chat on the owner's own box (docs/box-oauth.md, "Chat on
 * the owner's box"). A box page cannot open lianki-push's socket with a cookie,
 * so it asks here, with its token, for a 60 s single-use ticket. The ticket
 * names the box's exact origin and client; lianki-push takes it from that
 * origin only, and binds the socket to the owner's thread, chat only.
 *
 * Checked again here, on top of the gate (tokenMayCall + site owner): the
 * request carries the gate's signed identity, the client's binding is live and
 * holds box:chat, its account is the identity's, and that account is a site
 * owner now. Each mint is in security_audit.
 */
import { audit, type AuditDb } from "@/lib/security/audit-log";
import { BOX_IDENTITY_HEADER, verifyBoxIdentity, type BoxIdentity } from "./identity";
import { chatBinding, type Binding, type BoxDb } from "./store";

export type ChatTicketDeps = {
  secret: string | undefined;
  db: BoxDb;
  /** Signs a partner-key ticket for this origin and client; null while the key is unset. */
  sign: (o: { org: string; cid: string }) => Promise<{ ticket: string; exp: number } | null>;
  /** False once this client has asked too often. */
  allow: (clientId: string) => boolean;
  now?: () => number;
};

const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/** The box:chat binding a request may act for, or null: the same check the STT route makes. */
export async function boxChatCaller(
  headers: Headers,
  secret: string | undefined,
  db: BoxDb,
  now = Date.now(),
): Promise<{ who: BoxIdentity; binding: Binding } | null> {
  const who = await verifyBoxIdentity(secret, headers.get(BOX_IDENTITY_HEADER), now);
  if (!who) return null;
  const binding = await chatBinding(db, who.clientId, who.userId).catch(() => null);
  return binding ? { who, binding } : null;
}

export async function chatTicketResponse(headers: Headers, d: ChatTicketDeps): Promise<Response> {
  const now = d.now?.() ?? Date.now();
  // Not a box token's request (lianki.com's own pages included): nothing here.
  if (!headers.has(BOX_IDENTITY_HEADER)) return answer(404, { error: "Not found" });
  const caller = await boxChatCaller(headers, d.secret, d.db, now);
  if (!caller) return answer(403, { error: "Out of scope" });
  const { who, binding } = caller;
  if (!d.allow(who.clientId)) return answer(429, { error: "Too many requests" });
  const signed = await d.sign({ org: binding.origin, cid: binding.clientId }).catch(() => null);
  if (!signed) return answer(503, { error: "Chat tickets are off" });
  await audit(
    d.db as unknown as AuditDb,
    { kind: "box.chat-ticket", actor: who.userId, subject: who.userId, detail: who.clientId },
    now,
  );
  return answer(200, signed);
}
