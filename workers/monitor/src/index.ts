/**
 * lianki-monitor — metrics and alerts for the `lianki` Worker (see
 * wrangler.jsonc here). Two inputs:
 *
 *  - scheduled (every 5 min): probe the main pages from the edge, time them
 *    to response headers, and alert when one path is bad PROBE_STRIKES runs
 *    in a row (one cold start is not an outage); say so when it recovers;
 *  - tail (every real request to `lianki`): write wall/CPU time, status and
 *    outcome to Analytics Engine; alert on a burst of errors or of very slow
 *    requests within WINDOW_MS.
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
  nextStrikes,
  pathGroup,
  probeBad,
  secs,
  type Probe,
} from "./rules";

type KV = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
};
type Metrics = {
  writeDataPoint(p: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void;
};
type Env = {
  SITE: string;
  PROBE_PATHS: string;
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
  eventTimestamp?: number | null;
  wallTime?: number;
  cpuTime?: number;
  event?: {
    request?: { url: string; method?: string; headers?: Record<string, string> };
    response?: { status: number };
  } | null;
  exceptions?: { name: string; message: string }[];
};

/** Requests from this monitor carry this, so the tail does not count its own probes. */
const PROBE_UA = "lianki-monitor/1";
const PROBE_TIMEOUT_MS = 15_000;

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

/** Post `text` unless the same alert `key` was posted within REPEAT_MS. */
async function alertOnce(env: Env, key: string, text: string) {
  const k = `alerted:${key}`;
  if (await env.STATE.get(k)) return;
  await env.STATE.put(k, "1", { expirationTtl: Math.ceil(REPEAT_MS / 1000) });
  await post(env, text);
}

async function probe(env: Env, path: string): Promise<Probe> {
  const t0 = Date.now();
  try {
    const r = await fetch(env.SITE + path, {
      headers: { "user-agent": PROBE_UA, "cache-control": "no-cache" },
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const ms = Date.now() - t0;
    // Headers are what was timed; the body is not needed.
    await r.body?.cancel();
    return { path, status: r.status, ms };
  } catch (err) {
    return { path, status: 0, ms: Date.now() - t0, error: (err as Error).name || "error" };
  }
}

async function runProbes(env: Env) {
  const paths = env.PROBE_PATHS.split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const probes = await Promise.all(paths.map((p) => probe(env, p)));
  for (const p of probes) {
    env.METRICS.writeDataPoint({
      indexes: ["probe"],
      blobs: ["probe", p.path, String(p.status), p.error ?? ""],
      doubles: [p.ms],
    });
    const bad = probeBad(p);
    const key = `strikes:${p.path}`;
    const was = Number((await env.STATE.get(key)) ?? 0);
    const next = nextStrikes(was, bad !== null);
    if (next.strikes !== was) await env.STATE.put(key, String(next.strikes));
    if (next.alert)
      await post(
        env,
        `⚠️ lianki ${p.path} 连续 ${next.strikes} 次异常：${bad}（探测每 5 分钟一次）`,
      );
    if (next.recovered)
      await post(env, `✅ lianki ${p.path} 已恢复：${secs(p.ms)}，HTTP ${p.status}`);
  }
}

/** Recent error / slow-request times, per isolate (good enough for a burst detector). */
const errorTimes: number[] = [];
const slowTimes: number[] = [];
let recentErrors: string[] = [];
let recentSlow: string[] = [];

async function onTail(env: Env, traces: Trace[]) {
  const now = Date.now();
  for (const t of traces) {
    if (t.scriptName && t.scriptName !== "lianki") continue;
    const req = t.event?.request;
    if (!req) continue; // cron / queue events
    if (req.headers?.["user-agent"] === PROBE_UA) continue;
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
    if (failed) {
      errorTimes.splice(0, errorTimes.length, ...inWindow(errorTimes, now, now));
      recentErrors = [
        ...recentErrors.slice(-4),
        `${req.method ?? ""} ${path} → ${status || t.outcome}${t.exceptions?.[0] ? ` (${t.exceptions[0].message.slice(0, 80)})` : ""}`,
      ];
      if (errorTimes.length >= ERROR_BURST)
        await alertOnce(
          env,
          "errors",
          `🚨 lianki 10 分钟内 ${errorTimes.length} 个请求出错：\n${recentErrors.join("\n")}`,
        );
    }
    if (wall > REAL_SLOW_MS) {
      slowTimes.splice(0, slowTimes.length, ...inWindow(slowTimes, now, now));
      recentSlow = [...recentSlow.slice(-4), `${path} ${secs(wall)}（CPU ${secs(cpu)}）`];
      if (slowTimes.length >= SLOW_BURST)
        await alertOnce(
          env,
          "slow",
          `🐢 lianki 10 分钟内 ${slowTimes.length} 个请求超过 ${secs(REAL_SLOW_MS)}：\n${recentSlow.join("\n")}`,
        );
    }
  }
}

export default {
  async scheduled(_event: unknown, env: Env, ctx: Ctx) {
    ctx.waitUntil(runProbes(env));
  },
  async tail(traces: Trace[], env: Env, ctx: Ctx) {
    ctx.waitUntil(onTail(env, traces));
  },
  async fetch(): Promise<Response> {
    return new Response("lianki-monitor: alerts go to Slack #lianki\n");
  },
};
