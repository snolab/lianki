import { WorkerEntrypoint } from "cloudflare:workers";
import { recordMcp, type McpMonitorEnv } from "./mcp-metrics";
/** Reachable only by an explicitly configured service binding; no public ingest route. */
export class McpMetrics extends WorkerEntrypoint<McpMonitorEnv> {
  async record(metric: unknown): Promise<{ accepted: boolean }> {
    return recordMcp(this.env, metric);
  }
}
