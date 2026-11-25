/** Only aggregate numbers cross the private MCP → monitor binding. */
export const MCP_MONITOR_DEFAULTS = { waitP95AlertMs: 5000, waitMinSamples: 20 } as const;
export const MCP_WAIT_OUTCOMES = [
  "message",
  "history",
  "answered",
  "timeout",
  "auth",
  "rate",
  "network",
  "error",
] as const;
export type McpWaitMetric = {
  waitedMs: number;
  empty: boolean;
  lines: number;
  answered: number;
  outcome: (typeof MCP_WAIT_OUTCOMES)[number];
  deliveryMs: number | null;
  socketOpened: boolean;
  resumed: boolean;
};
export type McpMetric = {
  version: 1;
  wallMs: number;
  status: number;
  method: "POST" | "GET" | "DELETE" | "OTHER";
  wait?: McpWaitMetric;
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const bounded = (value: unknown, max: number, integer = false): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= max &&
  (!integer || Number.isInteger(value));
/** Reject unknown fields rather than accidentally carrying URLs/text/identities. */
export function parseMcpMetric(value: unknown): McpMetric | null {
  if (
    !object(value) ||
    !keys(value, ["version", "wallMs", "status", "method", "wait"]) ||
    value.version !== 1 ||
    !bounded(value.wallMs, 3600000) ||
    !bounded(value.status, 599, true) ||
    value.status < 100 ||
    !["POST", "GET", "DELETE", "OTHER"].includes(String(value.method))
  )
    return null;
  const metric: McpMetric = {
    version: 1,
    wallMs: value.wallMs,
    status: value.status,
    method: value.method as McpMetric["method"],
  };
  if (value.wait !== undefined) {
    const wait = value.wait;
    if (
      !object(wait) ||
      !keys(wait, [
        "waitedMs",
        "empty",
        "lines",
        "answered",
        "outcome",
        "deliveryMs",
        "socketOpened",
        "resumed",
      ]) ||
      !bounded(wait.waitedMs, 3600000) ||
      !bounded(wait.lines, 1000, true) ||
      !bounded(wait.answered, 1000, true) ||
      typeof wait.empty !== "boolean" ||
      typeof wait.socketOpened !== "boolean" ||
      typeof wait.resumed !== "boolean" ||
      !MCP_WAIT_OUTCOMES.includes(wait.outcome as McpWaitMetric["outcome"]) ||
      (wait.deliveryMs !== null && !bounded(wait.deliveryMs, 86400000)) ||
      wait.empty !== (wait.lines === 0 && wait.answered === 0)
    )
      return null;
    metric.wait = {
      waitedMs: wait.waitedMs,
      empty: wait.empty,
      lines: wait.lines,
      answered: wait.answered,
      outcome: wait.outcome as McpWaitMetric["outcome"],
      deliveryMs: wait.deliveryMs as number | null,
      socketOpened: wait.socketOpened,
      resumed: wait.resumed,
    };
  }
  return metric;
}
