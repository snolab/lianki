/**
 * lianki-monitor — metrics and alerts for the `lianki` Worker (see
 * wrangler.jsonc here). Event-driven only: no cron, no polling. As the tail
 * consumer of `lianki` it gets every real request's wall/CPU time, status and
 * outcome as it happens, writes them to Analytics Engine, and posts to Slack
 * when errors or very slow requests come in a burst within WINDOW_MS — and,
 * on a later request once the burst has passed, that it is over.
 *
 * The same alert is posted at most once per REPEAT_MS (KV). Slack: an
 * incoming webhook (SLACK_WEBHOOK_URL) or the bot (SLACK_BOT_TOKEN +
 * SLACK_CHANNEL); with neither, alerts only go to the Worker's logs.
 *
 * Types are declared here rather than taken from @cloudflare/workers-types:
 * the repo's root tsconfig type-checks this folder with the DOM lib.
 */
import {
  ERROR_BURST,
  REAL_SLOW_MS,
  REPEAT_MS,
  SLOW_BURST,
  inWindow,
  pathGroup,
  quiet,
  secs,
} from "./rules";

type KV = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
};
type Metrics = {
  writeDataPoint(p: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void;
};
type Env = {
  SLACK_CHANNEL: string;
  SLACK_WEBHOOK_URL?: string;
  SLACK_BOT_TOKEN?: string;
  STATE: KV;
  METRICS: Metrics;
};
type Ctx = { waitUntil(p: Promise<unknown>): void };
/** The parts of a tail TraceItem this reads. */
type Trace = {
  scriptName?: string | null;
  outcome: string;
  wallTime?: number;
  cpuTime?: number;
  event?: {
    request?: { url: string; method?: string };
    response?: { status: number };
  } | null;
  exceptions?: { name: string; message: string }[];
};

async function post(env: Env, text: string) {
  console.log(JSON.stringify({ msg: "monitor.alert", text }));
  try {
    if (env.SLACK_WEBHOOK_URL)
      await fetch(env.SLACK_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
    else if (env.SLACK_BOT_TOKEN)
      await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        },
        body: JSON.stringify({ channel: env.SLACK_CHANNEL, text }),
      });
  } catch (err) {
    console.log(JSON.stringify({ msg: "monitor.slack.failed", err: String(err) }));
  }
}

/** One kind of burst: recent event times and lines, per isolate. */
type Burst = {
  key: "errors" | "slow";
  times: number[];
  lines: string[];
  /** This isolate posted an alert that has not been closed yet. */
  open: boolean;
};
const bursts: Record<Burst["key"], Burst> = {
  errors: { key: "errors", times: [], lines: [], open: false },
  slow: { key: "slow", times: [], lines: [], open: false },
};

async function hit(
  env: Env,
  b: Burst,
  now: number,
  line: string,
  threshold: number,
  text: (b: Burst) => string,
) {
  b.times = inWindow(b.times, now, now);
  b.lines = [...b.lines.slice(-4), line];
  if (b.times.length < threshold) return;
  // The same alert at most once per REPEAT_MS, across isolates.
  const k = `alerted:${b.key}`;
  if (await env.STATE.get(k)) return;
  await env.STATE.put(k, "1", { expirationTtl: Math.ceil(REPEAT_MS / 1000) });
  b.open = true;
  await post(env, text(b));
}

/** On a request after an alert: once the window holds nothing more, say it is over. */
async function maybeClose(env: Env, b: Burst, now: number, text: string) {
  if (!b.open || !quiet(b.times, now)) return;
  b.open = false;
  await post(env, text);
}

async function onTail(env: Env, traces: Trace[]) {
  const now = Date.now();
  for (const t of traces) {
    if (t.scriptName && t.scriptName !== "lianki") continue;
    const req = t.event?.request;
    if (!req) continue;
    const status = t.event?.response?.status ?? 0;
    const path = pathGroup(req.url);
    const wall = t.wallTime ?? 0;
    const cpu = t.cpuTime ?? 0;
    env.METRICS.writeDataPoint({
      indexes: ["req"],
      blobs: ["req", path, String(status), t.outcome, req.method ?? ""],
      doubles: [wall, cpu],
    });
    const failed = t.outcome !== "ok" || status >= 500 || (t.exceptions?.length ?? 0) > 0;
    if (failed)
      await hit(
        env,
        bursts.errors,
        now,
        `${req.method ?? ""} ${path} → ${status || t.outcome}${t.exceptions?.[0] ? ` (${t.exceptions[0].message.slice(0, 80)})` : ""}`,
        ERROR_BURST,
        (b) => `🚨 lianki 10 分钟内 ${b.times.length} 个请求出错：\n${b.lines.join("\n")}`,
      );
    else
      await maybeClose(env, bursts.errors, now, "✅ lianki 出错已停止：最近 10 分钟没有新的错误");
    if (wall > REAL_SLOW_MS)
      await hit(
        env,
        bursts.slow,
        now,
        `${path} ${secs(wall)}（CPU ${secs(cpu)}）`,
        SLOW_BURST,
        (b) =>
          `🐢 lianki 10 分钟内 ${b.times.length} 个请求超过 ${secs(REAL_SLOW_MS)}：\n${b.lines.join("\n")}`,
      );
    else
      await maybeClose(
        env,
        bursts.slow,
        now,
        "✅ lianki 变慢已恢复：最近 10 分钟没有超过 5 秒的请求",
      );
  }
}

export default {
  async tail(traces: Trace[], env: Env, ctx: Ctx) {
    ctx.waitUntil(onTail(env, traces));
  },
  async fetch(): Promise<Response> {
    return new Response("lianki-monitor: event-driven alerts to Slack #lianki\n");
  },
};
