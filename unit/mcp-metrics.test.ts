import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { parseMcpMetric, type McpMetric } from "../lib/mcp-metrics";
import { createMcpRecorder, type McpMonitorEnv } from "../workers/monitor/src/mcp-metrics";
import worker from "../workers/mcp/src/index";
import { post } from "../workers/monitor/src/slack";
import { WINDOW_MS } from "../workers/monitor/src/rules";
const log = spyOn(console, "log").mockImplementation(() => {});
afterEach(() => log.mockClear());
afterAll(() => log.mockRestore());
const request = (): McpMetric => ({ version: 1, wallMs: 12, status: 200, method: "POST" });
const wait = (deliveryMs = 6000): McpMetric => ({
  ...request(),
  wait: {
    waitedMs: 55000,
    empty: false,
    lines: 1,
    answered: 0,
    outcome: "message",
    deliveryMs,
    socketOpened: true,
    resumed: false,
  },
});
function setup(values: Record<string, unknown> = {}) {
  const points: unknown[] = [];
  const flags = new Map<string, string>();
  const configCalls: string[] = [];
  const env: McpMonitorEnv = {
    SLACK_CHANNEL: "test-channel",
    METRICS: {
      writeDataPoint: (point) => {
        points.push(point);
      },
    },
    STATE: {
      get: async (key) => flags.get(key) ?? null,
      put: async (key, value) => {
        flags.set(key, value);
      },
    },
    SESSIONS: {
      config: async (key) => {
        configCalls.push(key);
        return values[key];
      },
    },
  };
  return { env, points, flags, configCalls };
}
describe("MCP metric schema", () => {
  test("accepts numeric summaries, rejects unknown or credential-bearing fields", () => {
    expect(parseMcpMetric(wait())).toEqual(wait());
    for (const input of [
      null,
      [],
      { ...request(), url: "https://site.invalid/mcp/private" },
      { ...request(), wallMs: NaN },
      { ...request(), method: "private-method" },
      { ...wait(), wait: { ...wait().wait, text: "private text" } },
      { ...wait(), wait: { ...wait().wait, deliveryMs: Infinity } },
      { ...wait(), wait: { ...wait().wait, empty: true } },
    ])
      expect(parseMcpMetric(input)).toBeNull();
  });
});
describe("private MCP recorder", () => {
  test("writes safe request and wait points, retaining no URLs or messages", async () => {
    const { env, points } = setup();
    expect(await createMcpRecorder()(env, wait(), 1)).toEqual({ accepted: true });
    expect(points).toEqual([
      {
        indexes: ["mcp"],
        blobs: ["mcp", "/mcp", "200", "ok", "POST", "application-wall"],
        doubles: [12, -1],
      },
      {
        indexes: ["mcp-wait"],
        blobs: ["mcp-wait", "message", "data", "opened", "next"],
        doubles: [55000, 6000, 1, 0, 0],
      },
    ]);
    expect(await createMcpRecorder()(env, { ...request(), token: "must-not-store" })).toEqual({
      accepted: false,
    });
    expect(JSON.stringify(points)).not.toContain("must-not-store");
    expect(JSON.stringify(log.mock.calls)).not.toContain("must-not-store");
  });
  test("normal 55-second empty waits and history never enter delivery p95 alerts", async () => {
    const { env, flags, points } = setup({ "mcp.waitMinSamples": 5 });
    const record = createMcpRecorder();
    for (let i = 0; i < 30; i++) {
      const input = wait();
      input.wait = {
        ...input.wait!,
        outcome: i % 2 ? "history" : "timeout",
        deliveryMs: null,
        empty: !(i % 2),
        lines: i % 2,
      };
      await record(env, input, 1000 + i);
    }
    expect(points).toHaveLength(60);
    expect(flags.size).toBe(0);
    expect(
      log.mock.calls.some(([message]) => String(message).includes('"msg":"monitor.alert"')),
    ).toBe(false);
  });
  test("p95 respects private live config and de-duplicates alerts", async () => {
    const { env, flags, configCalls } = setup({
      "mcp.waitP95AlertMs": 7000,
      "mcp.waitMinSamples": 5,
    });
    const record = createMcpRecorder();
    for (let i = 0; i < 5; i++) await record(env, wait(6000), 1000 + i);
    expect(flags.size).toBe(0);
    await record(env, wait(8000), 1006);
    expect(flags.has("alerted:mcp-latency")).toBe(true);
    await record(env, wait(8000), 1007);
    expect(
      log.mock.calls.filter(([message]) => String(message).includes('"msg":"monitor.alert"')),
    ).toHaveLength(1);
    expect(configCalls).toEqual(["mcp.waitP95AlertMs", "mcp.waitMinSamples"]);
  });
  test("expired samples do not make a new window alert; config is refreshed on events", async () => {
    const { env, flags, configCalls } = setup({ "mcp.waitMinSamples": 5 });
    const record = createMcpRecorder();
    for (let i = 0; i < 4; i++) await record(env, wait(), i);
    await record(env, wait(), WINDOW_MS + 10);
    expect(flags.size).toBe(0);
    expect(configCalls).toHaveLength(4);
  });
});
describe("MCP producer", () => {
  test("capability URL never crosses the RPC binding and raw tails stay unused", async () => {
    const metrics: unknown[] = [];
    const jobs: Promise<unknown>[] = [];
    const token = `lk_${"a".repeat(64)}`;
    const env = {
      MAIN: { fetch: async () => new Response("not found", { status: 404 }) },
      PUSH: { fetch: async () => new Response("not found", { status: 404 }) },
      MONITOR: {
        record: async (metric: McpMetric) => {
          metrics.push(metric);
          return { accepted: true };
        },
      },
    };
    const response = await worker.fetch(
      new Request(`https://lianki.com/mcp/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
      env,
      {
        waitUntil: (job) => {
          jobs.push(job);
        },
      },
    );
    expect(response.status).toBe(200);
    await Promise.all(jobs);
    expect(metrics).toHaveLength(1);
    expect(parseMcpMetric(metrics[0])).not.toBeNull();
    expect(JSON.stringify(metrics)).not.toContain(token);
    expect(JSON.stringify(metrics)).not.toContain("https:");
  });
  test("monitor unavailability never changes the MCP response", async () => {
    const response = await worker.fetch(new Request("https://lianki.com/mcp", { method: "GET" }), {
      MAIN: { fetch: async () => new Response() },
      PUSH: { fetch: async () => new Response() },
      MONITOR: {
        record: () => {
          throw new Error("unavailable");
        },
      },
    });
    expect(response.status).toBe(405);
  });
});

describe("shared Slack delivery", () => {
  test("existing webhook and bot delivery work without exposing credentials on errors", async () => {
    const seen: { url: string; body: string }[] = [];
    const originalFetch = globalThis.fetch;
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (
          input: Parameters<typeof globalThis.fetch>[0],
          init: Parameters<typeof globalThis.fetch>[1],
        ) => {
          seen.push({ url: String(input), body: String(init?.body) });
          return new Response("ok");
        },
        { preconnect: originalFetch.preconnect },
      ),
    );
    try {
      await post(
        { SLACK_CHANNEL: "test", SLACK_WEBHOOK_URL: "https://example.invalid/webhook" },
        "test alert",
      );
      await post({ SLACK_CHANNEL: "test", SLACK_BOT_TOKEN: "test-token" }, "test alert");
      expect(seen).toHaveLength(2);
      expect(seen[0].url).toBe("https://example.invalid/webhook");
      expect(JSON.parse(seen[1].body)).toEqual({ channel: "test", text: "test alert" });
      fetch.mockImplementation(
        Object.assign(
          async () => {
            throw new Error("private-transport-marker");
          },
          { preconnect: originalFetch.preconnect },
        ),
      );
      await post(
        { SLACK_CHANNEL: "test", SLACK_WEBHOOK_URL: "https://example.invalid/webhook" },
        "test alert",
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain("private-transport-marker");
    } finally {
      fetch.mockRestore();
    }
  });
});
