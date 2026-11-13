/**
 * lianki-mcp — the remote MCP server at https://lianki.com/mcp
 * (docs/api-for-agents.md, "Connect via MCP").
 *
 * Transport: MCP Streamable HTTP, stateless. One endpoint; a POST carries one
 * JSON-RPC message (initialize, ping, tools/list, tools/call; a notification
 * or a response is accepted with 202). The answer is JSON, or one
 * `text/event-stream` event when the client's Accept prefers that. There is
 * no session and nothing to stream unasked, so GET (the server-to-client
 * stream) and DELETE answer 405.
 *
 * Auth: `Authorization: Bearer <API token>`, the same token `lianki mcp` and
 * the REST API take. It is not checked here: it is forwarded, with the call,
 * to the main Worker (MAIN) or, for the chat, to lianki-push (PUSH), which
 * check it exactly as for any other API request — permissions, expiry,
 * account, rate limits. No header, or the server refusing the token (401),
 * answers HTTP 401 with `WWW-Authenticate: Bearer`. This Worker holds no
 * secret and no data, and never logs a token or a tool's arguments.
 *
 * Tools: the table of `lianki mcp` (packages/lianki-cli/mcp-tools.mjs) with
 * its API calls (packages/lianki-cli/api.mjs `call`), so both servers offer
 * the same tools with the same results. tools/list shows only what the
 * token's permissions allow (GET /api/cli-login/token, as the CLI asks).
 * Every call names itself `x-lianki-client: mcp-remote/<version> tool=<name>`
 * for the account's audit log (lib/api-token-client.ts).
 *
 * Why a Worker of its own: it went live before the main deploy could, and it
 * is a few hundred KB with no Next.js start-up in front of each call.
 *
 * Types are declared here rather than taken from @cloudflare/workers-types:
 * the repo's root tsconfig type-checks this folder with the DOM lib.
 */
import { CliError, EXIT, call } from "../../../packages/lianki-cli/api.mjs";
import {
  CHAT_PATH,
  CLIENT_HEADER,
  INSTRUCTIONS,
  TOOLS,
  UNTRUSTED_NOTE,
  inputJsonSchema,
  parseArgs,
  runTool,
  tokenScopes,
  toolError,
  toolsFor,
} from "../../../packages/lianki-cli/mcp-tools.mjs";

type Fetcher = { fetch(req: Request): Promise<Response> };
export type Env = { MAIN: Fetcher; PUSH: Fetcher };

export const MCP_PATH = "/mcp";
export const SERVER_VERSION = "1.0.0";
export const SITE = "https://lianki.com";
/** Newest first: what an initialize gets when it asks for a version we do not know. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
/** The largest request body read (an import of 100 pages is well under it). */
export const MAX_BODY = 1_000_000;

type Id = string | number | null;
type Rpc = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };

const NO_STORE = { "cache-control": "no-store" };
const AUTH_HEADERS = { ...NO_STORE, "www-authenticate": 'Bearer realm="lianki"' };

class Unauthorized extends Error {}

const rpcError = (id: Id, code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

function plain(body: unknown, status: number, headers: Record<string, string> = NO_STORE) {
  return Response.json(body, { status, headers });
}

/** Does the client's Accept rank text/event-stream above application/json? */
export function prefersStream(accept: string | null): boolean {
  const q = new Map<string, number>();
  for (const part of (accept ?? "").split(",")) {
    const [type, ...params] = part.trim().toLowerCase().split(";");
    const qp = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    const v = qp ? Number(qp.slice(2)) : 1;
    q.set(type, Number.isFinite(v) ? v : 0);
  }
  const json = Math.max(q.get("application/json") ?? 0, q.get("application/*") ?? 0);
  const sse = q.get("text/event-stream") ?? 0;
  return sse > json;
}

/** One JSON-RPC answer, as JSON or as a single SSE event. */
function answer(req: Request, body: unknown, status = 200, extra: Record<string, string> = {}) {
  if (prefersStream(req.headers.get("accept")))
    return new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, {
      status,
      headers: { ...NO_STORE, "content-type": "text/event-stream", ...extra },
    });
  return plain(body, status, { ...NO_STORE, ...extra });
}

/**
 * The CLI's call() context, against the bindings instead of the network. Every
 * request goes to lianki.com's own Workers: the chat to lianki-push (which
 * owns /api/version/*), everything else to the main Worker. A 401 is noted so
 * the whole MCP request can answer 401.
 */
function context(env: Env, seen: { unauthorized: boolean }) {
  return {
    base: SITE,
    site: "lianki.com",
    deps: {
      fetch: async (url: URL, init: RequestInit) => {
        const target = url.pathname.startsWith("/api/version/") ? env.PUSH : env.MAIN;
        const res = await target.fetch(new Request(url, init));
        if (res.status === 401) seen.unauthorized = true;
        return res;
      },
    },
  };
}

type Ctx = ReturnType<typeof context>;

async function scopesOf(c: Ctx, token: string): Promise<string[]> {
  try {
    return (await tokenScopes(c, token)) as string[];
  } catch (e) {
    if (e instanceof CliError && (e as { code?: string }).code === "auth_refused")
      throw new Unauthorized();
    throw e;
  }
}

function listed(t: (typeof TOOLS)[number]) {
  return {
    name: t.name,
    title: t.title,
    description: `${t.description} ${UNTRUSTED_NOTE}`,
    inputSchema: inputJsonSchema(t),
    annotations: t.annotations,
  };
}

async function dispatch(
  msg: Rpc,
  id: Id,
  token: string,
  env: Env,
): Promise<Record<string, unknown>> {
  const seen = { unauthorized: false };
  const c = context(env, seen);
  const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<
    string,
    unknown
  >;
  switch (msg.method) {
    case "initialize": {
      // The token is checked once here, so a bad one fails at connect.
      await scopesOf(c, token);
      const asked = params.protocolVersion;
      const version =
        typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked)
          ? asked
          : PROTOCOL_VERSIONS[0];
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "lianki", title: "Lianki", version: SERVER_VERSION },
          instructions: INSTRUCTIONS,
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list": {
      const scopes = await scopesOf(c, token);
      return { jsonrpc: "2.0", id, result: { tools: toolsFor(scopes).map(listed) } };
    }
    case "tools/call": {
      const t = TOOLS.find((x) => x.name === params.name);
      if (!t) return rpcError(id, -32602, `Unknown tool: ${String(params.name).slice(0, 64)}`);
      // Refused before anything runs when the token lacks the tool's permission
      // (the routes would refuse it too; this names the permission).
      if (!(await scopesOf(c, token)).includes(t.scope))
        return {
          jsonrpc: "2.0",
          id,
          result: {
            isError: true,
            content: [
              {
                type: "text",
                text: `This token lacks the "${t.scope}" permission that ${t.name} needs: make one that has it at lianki.com/my/preferences → API tokens.`,
              },
            ],
            _meta: { code: "auth_refused" },
          },
        };
      const parsed = parseArgs(t, params.arguments);
      if (!parsed.ok)
        return {
          jsonrpc: "2.0",
          id,
          result: {
            isError: true,
            content: [{ type: "text", text: `Invalid arguments: ${parsed.error}` }],
          },
        };
      const api = async (r: Record<string, unknown>) => {
        const headers = { [CLIENT_HEADER]: `mcp-remote/${SERVER_VERSION} tool=${t.name}` };
        return (await call(c, token, { ...r, headers } as Parameters<typeof call>[2])).data;
      };
      const result = await runTool(t, api as never, parsed.args as never);
      // The token itself refused (unknown, expired, revoked): the client should sign in again.
      if (seen.unauthorized) throw new Unauthorized();
      return { jsonrpc: "2.0", id, result };
    }
    default:
      return rpcError(id, -32601, `Method not found: ${String(msg.method).slice(0, 64)}`);
  }
}

export async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  // The route is lianki.com/mcp*: any other path under it (an /mcp-something page) is the app's.
  if (url.pathname !== MCP_PATH && url.pathname !== `${MCP_PATH}/`) return env.MAIN.fetch(req);
  if (req.method !== "POST")
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { ...NO_STORE, allow: "POST" },
    });

  const header = req.headers.get("authorization") ?? "";
  const bearer = /^Bearer\s+(\S+)$/i.exec(header);
  if (!bearer)
    return plain(
      rpcError(null, -32001, "Authorization: Bearer <your Lianki API token> is required"),
      401,
      AUTH_HEADERS,
    );
  const token = bearer[1];

  const pv = req.headers.get("mcp-protocol-version");
  if (pv !== null && !PROTOCOL_VERSIONS.includes(pv))
    return plain(
      rpcError(null, -32600, `Unsupported MCP-Protocol-Version: ${pv.slice(0, 32)}`),
      400,
    );

  const text = await req.text();
  if (text.length > MAX_BODY) return plain(rpcError(null, -32600, "Request too large"), 413);
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return plain(rpcError(null, -32700, "Parse error"), 400);
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg))
    return plain(rpcError(null, -32600, "Invalid Request: one JSON-RPC message per POST"), 400);
  const m = msg as Rpc;
  if (m.jsonrpc !== "2.0") return plain(rpcError(null, -32600, "Invalid Request"), 400);
  // A notification (no id) or a response to us: nothing to answer.
  if (m.id === undefined || m.id === null || typeof m.method !== "string")
    return new Response(null, { status: 202, headers: NO_STORE });
  if (typeof m.id !== "string" && typeof m.id !== "number")
    return plain(rpcError(null, -32600, "Invalid Request: id"), 400);
  const id = m.id;

  try {
    return answer(req, await dispatch(m, id, token, env));
  } catch (e) {
    if (e instanceof Unauthorized)
      return plain(
        rpcError(id, -32001, "Lianki refused the token (unknown, expired or revoked)"),
        401,
        AUTH_HEADERS,
      );
    // Never the token or the arguments: only what failed.
    const err = toolError(
      e instanceof CliError ? e : new CliError("internal", EXIT.server, "internal error"),
    );
    return answer(req, rpcError(id, -32603, err.content[0].text));
  }
}
