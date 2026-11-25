import { MCP_MONITOR_DEFAULTS, parseMcpMetric } from "../../../lib/mcp-metrics";
import { post, type SlackEnv } from "./slack";
import { REPEAT_MS, WINDOW_MS, secs } from "./rules";
export type McpMonitorEnv = SlackEnv & {
  METRICS: {
    writeDataPoint(point: { indexes: string[]; blobs: string[]; doubles: number[] }): void;
  };
  STATE: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, opts: { expirationTtl: number }): Promise<void>;
  };
  SESSIONS?: { config(key: string): Promise<unknown> };
};
/** Bounded isolate-local window. AE is the durable source for account-wide queries. */
export function createMcpRecorder() {
  let samples: { at: number; value: number }[] = [];
  let config: { at: number; threshold: number; minimum: number } | undefined;
  async function settings(env: McpMonitorEnv, now: number) {
    if (config && now - config.at < WINDOW_MS) return config;
    let threshold: unknown;
    let minimum: unknown;
    try {
      [threshold, minimum] = await Promise.all([
        env.SESSIONS?.config("mcp.waitP95AlertMs"),
        env.SESSIONS?.config("mcp.waitMinSamples"),
      ]);
    } catch {
      /* Code defaults when the existing private config service is unavailable. */
    }
    config = {
      at: now,
      threshold:
        typeof threshold === "number" &&
        Number.isInteger(threshold) &&
        threshold >= 100 &&
        threshold <= 60000
          ? threshold
          : MCP_MONITOR_DEFAULTS.waitP95AlertMs,
      minimum:
        typeof minimum === "number" && Number.isInteger(minimum) && minimum >= 5 && minimum <= 256
          ? minimum
          : MCP_MONITOR_DEFAULTS.waitMinSamples,
    };
    return config;
  }
  return async (env: McpMonitorEnv, input: unknown, now = Date.now()) => {
    const metric = parseMcpMetric(input);
    if (!metric) return { accepted: false };
    env.METRICS.writeDataPoint({
      indexes: ["mcp"],
      blobs: [
        "mcp",
        "/mcp",
        String(metric.status),
        metric.status >= 500 ? "error" : "ok",
        metric.method,
        "application-wall",
      ],
      // -1 means CPU unavailable: raw invocation tails stay disabled for credential URL safety.
      doubles: [metric.wallMs, -1],
    });
    const wait = metric.wait;
    if (wait) {
      env.METRICS.writeDataPoint({
        indexes: ["mcp-wait"],
        blobs: [
          "mcp-wait",
          wait.outcome,
          wait.empty ? "empty" : "data",
          wait.socketOpened ? "opened" : "unopened",
          wait.resumed ? "cursor" : "next",
        ],
        doubles: [
          wait.waitedMs,
          wait.deliveryMs ?? -1,
          wait.lines,
          wait.answered,
          wait.outcome === "network" ? 1 : 0,
        ],
      });
    }
    // Only this allowlisted aggregate is logged; no original request or chat objects.
    console.log(JSON.stringify({ msg: "mcp.metrics", ...metric }));
    samples = samples.filter((sample) => now - sample.at < WINDOW_MS);
    if (wait?.outcome !== "message" || wait.deliveryMs === null) return { accepted: true };
    samples = [...samples.slice(-255), { at: now, value: wait.deliveryMs }];
    const cfg = await settings(env, now);
    if (samples.length < cfg.minimum) return { accepted: true };
    const ordered = samples.map((sample) => sample.value).sort((a, b) => a - b);
    const p95 = ordered[Math.ceil(ordered.length * 0.95) - 1];
    if (p95 <= cfg.threshold || (await env.STATE.get("alerted:mcp-latency")))
      return { accepted: true };
    await env.STATE.put("alerted:mcp-latency", "1", { expirationTtl: Math.ceil(REPEAT_MS / 1000) });
    await post(
      env,
      `🐢 MCP 实时消息投递变慢：最近 10 分钟 ${samples.length} 次实时投递，p95 ${secs(p95)}，超过 ${secs(cfg.threshold)}。正常空等与历史补读不计入告警。`,
    );
    return { accepted: true };
  };
}
export const recordMcp = createMcpRecorder();
