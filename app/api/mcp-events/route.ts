import { dbBackend, getD1 } from "@/lib/d1";
import type { D1Like } from "@/lib/d1/types";
import { eventsDeps } from "@/lib/mcp-events/deps";
import { eventsRpc } from "@/lib/mcp-events/server";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
const TOKEN_RE = /^lk_[0-9a-f]{64}$/;

/**
 * POST /api/mcp-events  Authorization: Bearer lk_…  {method, params}
 *   → {result} | {error: {code, message, data?}}
 *
 * MCP Events for the remote MCP server (docs/chat-wake.md): lianki-mcp
 * forwards events/probe, events/list, events/subscribe and events/unsubscribe
 * here with the caller's own token; lib/mcp-events/server.ts decides. 401 only
 * when the token itself is refused. Behind the flag mcp.events (off).
 */
export async function POST(req: Request) {
  if (dbBackend() !== "d1")
    return Response.json({ error: "unavailable" }, { status: 503, headers: NO_STORE });
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!bearer || !TOKEN_RE.test(bearer))
    return Response.json(
      { error: { code: -32001, message: "Authorization: Bearer <API token> is required" } },
      { status: 401, headers: NO_STORE },
    );
  const text = await req.text();
  if (text.length > 16_384)
    return Response.json(
      { error: { code: -32600, message: "Request too large" } },
      { status: 413, headers: NO_STORE },
    );
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json(
      { error: { code: -32700, message: "Parse error" } },
      { status: 400, headers: NO_STORE },
    );
  }
  const deps = eventsDeps(getD1() as unknown as D1Like, process.env.AUTH_SECRET);
  const out = await eventsRpc(deps, bearer, body);
  return Response.json(out.body, { status: out.status, headers: NO_STORE });
}
