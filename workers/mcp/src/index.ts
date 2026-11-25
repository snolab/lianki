/**
 * lianki-mcp's entry: only the handler may be exported from it (workerd
 * rejects any other named export). The server, and why, is in ./mcp.ts.
 */
import { handle, type Env } from "./mcp";
import { parseMcpMetric, type McpWaitMetric } from "../../../lib/mcp-metrics";

export default {
  async fetch(
    req: Request,
    env: Env,
    ctx?: { waitUntil(task: Promise<unknown>): void },
  ): Promise<Response> {
    const started = Date.now();
    const path = new URL(req.url).pathname;
    const tracked = path === "/mcp" || path.startsWith("/mcp/") || path.startsWith("/mcp%");
    let wait: McpWaitMetric | undefined;
    let status = 500;
    try {
      const response = await handle(req, {
        ...env,
        observeWait: (metric) => {
          wait = metric;
        },
      });
      status = response.status;
      return response;
    } finally {
      if (tracked && env.MONITOR) {
        const metric = parseMcpMetric({
          version: 1,
          wallMs: Math.max(0, Math.min(3600000, Date.now() - started)),
          status,
          method: ["POST", "GET", "DELETE"].includes(req.method) ? req.method : "OTHER",
          ...(wait ? { wait } : {}),
        });
        if (metric) {
          // No URL, headers, token, user identity or message data enter the binding.
          const report = Promise.resolve()
            .then(() => env.MONITOR!.record(metric))
            .catch(() => undefined);
          if (ctx) ctx.waitUntil(report);
          else await report;
        }
      }
    }
  },
};
