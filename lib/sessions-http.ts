/** Only reachable through the DebugSessions service binding, never the public router. */
export const SESSION_METHODS = [
  "live",
  "flag",
  "config",
  "boxChat",
  "boxEval",
  "partnerReply",
  "prepareChatTurn",
  "polishLines",
  "inbox",
  "chatToken",
  "evalToken",
  "chatLog",
] as const;
export type SessionMethod = (typeof SESSION_METHODS)[number];
export async function sessionsHttp(
  request: Request,
  call: (method: SessionMethod, args: unknown[], signal: AbortSignal) => Promise<unknown>,
): Promise<Response> {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/internal/rpc")
    return new Response(null, { status: 404 });
  const body = (await request.json().catch(() => null)) as {
    method?: unknown;
    args?: unknown;
  } | null;
  if (
    !body ||
    !SESSION_METHODS.includes(body.method as SessionMethod) ||
    !Array.isArray(body.args) ||
    body.args.length > 2
  )
    return Response.json({ error: "bad-input" }, { status: 400 });
  request.signal.throwIfAborted();
  const value = await call(body.method as SessionMethod, body.args, request.signal);
  return Response.json({ value: value ?? null }, { headers: { "cache-control": "no-store" } });
}
