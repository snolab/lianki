/**
 * POST /api/chat/li-ticket — the account-scoped Li chat ticket for the
 * userscript pill (docs/userscript-li-chat.md, M2).
 *
 * A 60 s, single-use ticket (Ed25519, STT_TICKET_KEY, audience
 * LI_CHAT_TICKET_AUD) that names the caller's own account (`sub`, the D1 user
 * id, never an email). The userscript fetches it with GM_xmlhttpRequest (the
 * lianki.com session, or `lk:token` holding chat:read and chat:write) and
 * writes it only into the frame's MessagePort; the lianki.com frame offers it
 * in Sec-WebSocket-Protocol. lianki-push takes it only from the lianki.com
 * origin, burns its jti, and binds the socket to that account's own thread as
 * a chat-only page: never the owner's thread, never eval, never a pairing
 * (workers/push/src/auth.ts liChatTicket, debug.ts connectPage).
 *
 * 404 (says nothing) unless: the userscript header is there (a web page cannot
 * send it cross-origin without a preflight, which is never answered), the
 * flags `ext.pill-chat` AND `ext.pill-chat-users` are on, and a signed-in
 * account asks that does not hold `dev` (the owner keeps his partner ticket,
 * his own thread). 429 past config `chat.pillTicketsPerMinute` per account,
 * 503 while the signing key is not set. POST and no-store: nothing caches or
 * prefetches it.
 */
import { flagIn } from "@/lib/flags";
import { PER_ORIGIN_FLAG, siteBinding } from "@/lib/li-thread";
import { pillChatAccess, type PillChatRouteDeps } from "@/lib/pill-chat-route";
import {
  LI_CHAT_TICKET_AUD,
  PARTNER_TICKET_HEADER,
  isTicketSub,
  signSttTicket,
} from "@/lib/stt-ticket";

export type LiTicketDeps = PillChatRouteDeps & {
  /** STT_TICKET_KEY's private key, or null when it is not set or unreadable. */
  key: () => Promise<CryptoKey | null>;
  /** One more ticket for this account this minute? (config chat.pillTicketsPerMinute) */
  allow: (userId: string) => Promise<boolean>;
  /** The site-hash key (lib/li-thread.ts threadHashKeyFromJwk), or null when it is not set. */
  threadKey?: () => Promise<CryptoKey | null>;
};

const json = (body: unknown, status: number) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

export async function liTicket(req: Request, deps: LiTicketDeps): Promise<Response> {
  const none = () => json({ error: "Not found" }, 404);
  if (req.method !== "POST" || req.headers.get(PARTNER_TICKET_HEADER) !== "1") return none();
  const a = await pillChatAccess(req, deps);
  // The owner's pill uses his partner ticket: an account ticket never names a dev account.
  if (!a || a.ticket !== "account" || !isTicketSub(a.user.id)) return none();
  // pillChatAccess read the users flag already; asked again here so a refactor there cannot widen this.
  const flags = await deps.flags();
  if (!flagIn(flags, "ext.pill-chat-users")) return none();
  // Per-site threads: this ticket opens only the thread of the site that asked for it.
  const site = await siteBinding(req, flagIn(flags, PER_ORIGIN_FLAG), a.user.id, deps.threadKey);
  if (!site) return none();
  if (!(await deps.allow(a.user.id))) return json({ error: "Too many tickets" }, 429);
  const key = await deps.key();
  if (!key) return json({ error: "Li chat tickets are off" }, 503);
  const { ticket, exp } = await signSttTicket(key, {
    aud: LI_CHAT_TICKET_AUD,
    sub: a.user.id,
    ...site,
    now: deps.now?.(),
  });
  return json({ ticket, exp }, 200);
}
