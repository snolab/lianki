/**
 * GET /api/chat/sites — the signed-in account's Li chats from the userscript
 * pill, one per website (docs/userscript-li-chat.md, "Per-site threads";
 * lib/li-thread.ts). lianki-push holds them; this asks it over the PUSH
 * binding for the session's own account only: the owner's sites live under
 * his own thread ("owner"), anyone else's under their user id. No request can
 * name another account. 404 while `ext.pill-chat-per-origin` is off, and for
 * no session. Only for lianki.com: never sent to a host page.
 */
import { DISPATCH_THREAD, isUserId } from "@/lib/dev-eval";
import { flagIn, type FlagValues } from "@/lib/flags";
import { PER_ORIGIN_FLAG, type SiteThread } from "@/lib/li-thread";

export type ChatSitesDeps = {
  /** The session's account and whether it holds `dev` (his sites are under "owner"); null = signed out. */
  who: () => Promise<{ id: string; owner: boolean } | null>;
  flags: () => Promise<FlagValues>;
  /** lianki-push's list for that base thread; null = not reachable (no binding). */
  list: (base: string) => Promise<SiteThread[] | null>;
};

const json = (body: unknown, status: number) =>
  Response.json(body, { status, headers: { "cache-control": "private, no-store" } });

export async function chatSites(req: Request, deps: ChatSitesDeps): Promise<Response> {
  const none = () => json({ error: "Not found" }, 404);
  if (req.method !== "GET") return none();
  if (!flagIn(await deps.flags(), PER_ORIGIN_FLAG)) return none();
  const me = await deps.who();
  if (!me || !isUserId(me.id)) return none();
  const base = me.owner ? DISPATCH_THREAD : me.id;
  const threads = await deps.list(base);
  if (!threads) return json({ error: "Chats by site are not reachable" }, 503);
  return json({ threads }, 200);
}
