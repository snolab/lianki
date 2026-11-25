/**
 * POST /api/chat/redact {id} (docs/chat-history.md, "Deleting a line"): the
 * signed-in owner of a thread deletes one of its lines. The hub
 * (lianki-push, DebugHub.redact) clears every copy it keeps and audits it.
 *
 * Who may: a session alone, from a lianki.com page (JSON, same origin; a
 * cross-site form or fetch is refused). Never a Bearer token: no lane token,
 * no `lianki chat` or MCP token, no eval token. The thread is the caller's
 * own, decided here and never read from the request: the dispatch thread for
 * a `dev` holder (lib/permissions.ts isDev), else their own Learning Partner
 * thread. Another account's line is not in that thread, so it answers 404.
 */
import { sameOriginPost } from "./cli-login";
import { REDACT_ID } from "./chat-redact";
import { DISPATCH_THREAD } from "./dev-eval";

export type RedactUser = { id: string; dev: boolean };

export type RedactDeps = {
  /** The session's user, or null. */
  who: () => Promise<RedactUser | null>;
  /** lianki-push's /internal/chat-redact over the PUSH binding (null: no binding). */
  push: () => { fetch(url: string, init?: RequestInit): Promise<Response> } | null;
};

const json = (v: unknown, status = 200) =>
  Response.json(v, { status, headers: { "cache-control": "no-store" } });

export async function redactLine(req: Request, deps: RedactDeps): Promise<Response> {
  // Tokens never delete: whatever else the request carries.
  if (req.headers.get("authorization")) return json({ error: "session-only" }, 403);
  if (!sameOriginPost(req)) return json({ error: "same-origin-only" }, 403);
  const user = await deps.who();
  if (!user) return json({ error: "not-found" }, 404);
  const body = (await req.json().catch(() => null)) as { id?: unknown } | null;
  const id = body?.id;
  if (typeof id !== "string" || !REDACT_ID.test(id)) return json({ error: "bad-id" }, 400);
  const push = deps.push();
  if (!push) return json({ error: "hub-unavailable" }, 503);
  const thread = user.dev ? DISPATCH_THREAD : user.id;
  const res = await push.fetch("https://lianki-push/internal/chat-redact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ thread, id, actor: user.id }),
  });
  if (res.status === 404) return json({ error: "not-found" }, 404);
  if (!res.ok) return json({ error: "not-deleted" }, 502);
  const out = (await res.json().catch(() => ({}))) as { ids?: string[] };
  return json({ ok: true, ids: out.ids ?? [id] });
}
