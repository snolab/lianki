/**
 * Page-realm portable Li: a session-only, short-lived, site-bound chat capability.
 * No API-token fallback, no parent-chosen account/thread, no general credentials.
 */
import { DISPATCH_THREAD } from "@/lib/dev-eval";
import { siteBinding } from "@/lib/li-thread";
import type { LiTicketDeps } from "@/lib/li-ticket-route";
import { pillChatAccess } from "@/lib/pill-chat-route";
import {
  PAGE_CHAT_TICKET_AUD,
  PARTNER_TICKET_HEADER,
  isTicketSub,
  signSttTicket,
} from "@/lib/stt-ticket";

export async function pageChatTicket(req: Request, deps: LiTicketDeps): Promise<Response> {
  const json = (body: unknown, status: number) =>
    Response.json(body, {
      status,
      headers: { "cache-control": "private, no-store" },
    });
  const none = () => json({ error: "Not found" }, 404);
  if (
    req.method !== "POST" ||
    req.headers.get(PARTNER_TICKET_HEADER) !== "1" ||
    req.headers.has("authorization")
  )
    return none();
  const access = await pillChatAccess(req, deps);
  if (!access || !isTicketSub(access.user.id)) return none();
  const owner = access.ticket === "owner";
  // Always a distinct site's thread, even when ordinary per-site chat is off.
  // These lines never become instructions on the account's privileged main thread.
  const site = await siteBinding(
    req,
    true,
    owner ? DISPATCH_THREAD : access.user.id,
    deps.threadKey,
  );
  if (!site?.ho || !site.th) return none();
  if (!(await deps.allow(access.user.id))) return json({ error: "Too many tickets" }, 429);
  const key = await deps.key();
  if (!key) return json({ error: "Li chat tickets are off" }, 503);
  const { ticket, exp } = await signSttTicket(key, {
    aud: PAGE_CHAT_TICKET_AUD,
    sub: access.user.id,
    ...(owner ? { own: true as const } : {}),
    ...site,
    now: deps.now?.(),
  });
  // Echo only the authenticated identity, so an old consent cannot adopt a new cookie account.
  return json({ ticket, exp, principal: access.user.id }, 200);
}
