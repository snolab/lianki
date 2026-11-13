/**
 * lianki-mcp's entry: only the handler may be exported from it (workerd
 * rejects any other named export). The server, and why, is in ./mcp.ts.
 */
import { handle, type Env } from "./mcp";

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handle(req, env);
  },
};
