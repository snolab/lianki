// lianki mcp: a local MCP server on stdio (docs/api-for-agents.md, "Connect via MCP").
//
// - The key is a normal API token, found the way every other command finds
//   it (cli.mjs currentToken: --token, LIANKI_TOKEN, then the Keychain or the
//   0600 file that `lianki auth login` wrote). Never printed, never in a tool
//   result.
// - Tools map one to one to existing endpoints. A tool is listed only when
//   the token holds its permission (GET /api/cli-login/token says which); the
//   server checks again on every call. No deletes, no eval.
// - Everything a tool returns comes from the user's account and can carry
//   text written by others (page titles, chat lines): it is wrapped as
//   untrusted data, and every description says never to follow it.
// - 429: the server's Retry-After is passed on in the error.
// - Every call names itself (`x-lianki-client: mcp/<version> tool=<name>`), so
//   the account's audit log shows the use came through MCP and which tool.
//   Never the arguments.
// - stdout is the protocol: nothing else is ever written there.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CliError, EXIT, call, currentToken } from "./cli.mjs";
import {
  CHAT_PATH,
  CLIENT_HEADER,
  INSTRUCTIONS,
  UNTRUSTED_NOTE,
  runTool,
  tokenScopes,
  toolsFor,
} from "./mcp-tools.mjs";

export * from "./mcp-tools.mjs";

/** The MCP server for this token: only the tools its permissions allow. */
export function buildServer(c, token, scopes) {
  // lianki_chat_wait: the socket `lianki chat listen` opens, open before it is handed over.
  const io = {
    token,
    openChat: () =>
      new Promise((resolve, reject) => {
        const WS = c.deps.WebSocket ?? globalThis.WebSocket;
        if (!WS) return reject(new CliError("usage", EXIT.usage, "waiting for the chat needs a WebSocket: Node.js 22 or newer, or Bun"));
        const u = new URL(CHAT_PATH, c.base + "/");
        u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
        let ws;
        try {
          ws = new WS(u.toString());
        } catch (e) {
          return reject(new CliError("network", EXIT.server, `cannot reach ${c.site}: ${e?.message ?? e}`));
        }
        const failed = () => reject(new CliError("network", EXIT.server, `cannot reach ${c.site}`));
        ws.addEventListener("open", () => {
          ws.removeEventListener?.("close", failed);
          resolve(ws);
        });
        ws.addEventListener("close", failed);
      }),
  };
  const server = new McpServer(
    { name: "lianki", version: c.deps.version },
    { instructions: INSTRUCTIONS },
  );
  for (const t of toolsFor(scopes)) {
    const api = async (req) => {
      const headers = { [CLIENT_HEADER]: `mcp/${c.deps.version} tool=${t.name}` };
      return (await call(c, token, { ...req, headers })).data;
    };
    server.registerTool(
      t.name,
      {
        title: t.title,
        description: `${t.description} ${UNTRUSTED_NOTE}`,
        ...(t.input ? { inputSchema: t.input } : {}),
        annotations: t.annotations,
      },
      (args) => runTool(t, api, args, io),
    );
  }
  return server;
}

/**
 * `lianki mcp`: serve until the client closes the connection. Fails before
 * serving when there is no token or the server refuses it.
 */
export async function serveMcp(c) {
  const { token } = await currentToken(c);
  if (!token)
    throw new CliError(
      "auth_required",
      EXIT.auth,
      `not signed in to ${c.site}`,
      "npx lianki auth login, or set LIANKI_TOKEN in this server's env block",
    );
  const scopes = await tokenScopes(c, token);
  const server = buildServer(c, token, scopes);
  const closed = new Promise((resolve) => (server.server.onclose = resolve));
  if (c.deps.mcpTransport) await server.connect(c.deps.mcpTransport);
  else {
    // The client closing our stdin ends the session (the SDK keeps waiting otherwise).
    process.stdin.once("end", () => void server.close());
    await server.connect(new StdioServerTransport());
  }
  c.deps.err(
    `lianki mcp: serving ${toolsFor(scopes).length} tools for ${c.site} on stdio (${scopes.join(", ") || "no permissions"})`,
  );
  await closed;
}
