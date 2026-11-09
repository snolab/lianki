/**
 * Who may have a Learning Partner ticket (`POST /api/debug/partner-ticket`,
 * docs/dev-debug-widget.md "On every site"). The ticket names no account: a
 * socket that offers it is bound to the owner's thread, chat only (no eval,
 * no pairing, no grant; workers/push/src/debug.ts). So the caller must be the
 * owner, and must be allowed to chat.
 *
 * - A lianki.com session (the userscript's GM request carries the cookie):
 *   the owner's session is the owner.
 * - An API token (`Authorization: Bearer lk_…`, the userscript's `lk:token`):
 *   only with BOTH `chat:read` and `chat:write` (lib/api-tokens.ts SCOPES),
 *   as for `lianki chat` (lib/chat-token.ts). `study` is cards and settings
 *   and never a chat ticket. A token that does not qualify counts for
 *   nothing: the session still decides, and without one the answer is 404.
 *
 * Every other token kind (a box's `lkb_`, anything malformed) is ignored the
 * same way. On the frozen Mongo copy no token counts (D1 only).
 */
import { checkToken } from "@/lib/api-tokens";
import type { D1Like } from "@/lib/d1/types";
import { PARTNER_TICKET_AUD, PARTNER_TICKET_HEADER, signSttTicket } from "@/lib/stt-ticket";

/** What a token needs for a partner ticket: the socket reads the thread and posts to it. */
export const PARTNER_TOKEN_SCOPES = ["chat:read", "chat:write"] as const;

export type PartnerTicketDeps = {
  backend: () => "mongodb" | "d1";
  d1: () => D1Like;
  /** The signed-in session's email, or null. */
  sessionEmail: () => Promise<string | null>;
  /** Does this account hold `dev` (refreshing the grants first: a token reads no session)? */
  isDev: (email: string | null) => Promise<boolean>;
  /** STT_TICKET_KEY's private key, or null when it is not set or unreadable. */
  key: () => Promise<CryptoKey | null>;
  now?: () => number;
};

/** The token's account email when it may chat, else null. */
export async function partnerTokenEmail(
  req: Request,
  deps: Pick<PartnerTicketDeps, "backend" | "d1" | "now">,
): Promise<string | null> {
  const m = /^Bearer (lk_[0-9a-f]{64})$/.exec(req.headers.get("Authorization") ?? "");
  if (!m || deps.backend() !== "d1") return null;
  const now = deps.now?.() ?? Date.now();
  const r = await checkToken(deps.d1(), m[1], PARTNER_TOKEN_SCOPES[0], now);
  if (!r.ok) return null;
  return PARTNER_TOKEN_SCOPES.every((s) => r.scopes.includes(s)) ? r.user.email : null;
}

const json = (body: unknown, status: number) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** The whole route: 404 for anyone but the owner (by session, or a chat token); 503 with no key. */
export async function partnerTicket(req: Request, deps: PartnerTicketDeps): Promise<Response> {
  if (req.headers.get(PARTNER_TICKET_HEADER) !== "1") return json({ error: "Not found" }, 404);
  const email = (await partnerTokenEmail(req, deps)) ?? (await deps.sessionEmail());
  if (!email || !(await deps.isDev(email))) return json({ error: "Not found" }, 404);
  const key = await deps.key();
  if (!key) return json({ error: "Partner tickets are off" }, 503);
  // Audience and expiry only: a partner ticket is chat-only by its audience.
  const { ticket, exp } = await signSttTicket(key, {
    aud: PARTNER_TICKET_AUD,
    now: deps.now?.(),
  });
  return json({ ticket, exp }, 200);
}
