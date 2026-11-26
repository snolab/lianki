/** Cookie-authenticated, chat-only GM broker. No credential is returned to the host page. */
import { publicPageChatResult } from "./page-chat-http-result";
import { clearDictation } from "./dictation-clear";
import { flagIn } from "./flags";
import { DISPATCH_THREAD } from "./dev-eval";
import { siteBinding } from "./li-thread";
import type { LiTicketDeps } from "./li-ticket-route";
import { pillChatAccess } from "./pill-chat-route";
import { PARTNER_TICKET_HEADER, isTicketSub } from "./stt-ticket";
import { signPageChatHttpTicket } from "./page-chat-http-ticket";
import {
  PAGE_CHAT_HTTP_INTERNAL_PATH,
  PAGE_CHAT_HTTP_HEADER,
  PAGE_CHAT_PRINCIPAL_HEADER,
  readPageChatHttpInput,
  type PageChatHttpResult,
} from "./page-chat-http-wire";
export type PageChatHttpDeps = LiTicketDeps & {
  push: () => { fetch: (request: Request) => Promise<Response> } | null;
  allowDictation?: (sub: string) => Promise<boolean>;
};
const json = (body: PageChatHttpResult, status = 200) =>
  Response.json(body, {
    status,
    headers: { "cache-control": "private, no-store" },
  });
export async function pageChatHttp(req: Request, deps: PageChatHttpDeps): Promise<Response> {
  if (
    req.method !== "POST" ||
    req.headers.get(PARTNER_TICKET_HEADER) !== "1" ||
    req.headers.has("authorization")
  )
    return json({ ok: false, error: "invalid" }, 404);
  const action = await readPageChatHttpInput(req);
  if (!action || action === "too-large")
    return json({ ok: false, error: action === "too-large" ? action : "invalid" }, 400);
  const access = await pillChatAccess(req, deps);
  if (!access || !isTicketSub(access.user.id)) return json({ ok: false, error: "signed-out" }, 403);
  const dictation =
    action.op === "route" || (action.op === "read" && action.dictation !== undefined);
  if (
    !(await (dictation && deps.allowDictation ? deps.allowDictation : deps.allow)(access.user.id))
  )
    return json({ ok: false, error: "rate-limited" }, 429);
  if (action.op === "hello") return json({ ok: true, kind: "hello", principal: access.user.id });
  if (req.headers.get(PAGE_CHAT_PRINCIPAL_HEADER) !== access.user.id)
    return json({ ok: false, error: "account-changed" }, 409);
  if (
    dictation &&
    (access.ticket !== "owner" || !flagIn(await deps.flags(), "portable.mic-route"))
  ) {
    // The public off response must not leave an old live target behind the hub's flag cache.
    if (access.ticket === "owner") await clearDictation(deps.push(), access.user.id);
    return json({ ok: false, error: "off" }, 403);
  }
  const owner = access.ticket === "owner";
  const site = await siteBinding(
    req,
    true,
    owner ? DISPATCH_THREAD : access.user.id,
    deps.threadKey,
  );
  if (!site?.ho || !site.th) return json({ ok: false, error: "invalid" }, 400);
  const key = await deps.key();
  const push = deps.push();
  if (!key || !push) return json({ ok: false, error: "unavailable" }, 503);
  const ticket = await signPageChatHttpTicket(
    key,
    {
      sub: access.user.id,
      ...(owner ? { own: true as const } : {}),
      ho: site.ho,
      th: site.th,
    },
    action,
    deps.now?.(),
  );
  try {
    const response = await push.fetch(
      new Request(`https://lianki-push${PAGE_CHAT_HTTP_INTERNAL_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", [PAGE_CHAT_HTTP_HEADER]: ticket },
        body: JSON.stringify(action),
        signal: req.signal,
      }),
    );
    // Return only the narrow JSON result, never upstream headers or capability material.
    const body = publicPageChatResult(await response.json());
    if (!body || typeof body !== "object" || typeof body.ok !== "boolean")
      throw new Error("invalid broker response");
    return json(body, response.status);
  } catch {
    return json({ ok: false, error: "unavailable" }, 503);
  }
}
