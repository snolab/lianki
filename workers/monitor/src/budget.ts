import { MONITOR_BUDGET_DEFAULTS as DEFAULTS } from "../../../lib/monitor-budget";
import { post, type SlackEnv } from "./slack";
import { REPEAT_MS, WINDOW_MS } from "./rules";

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const MAX_PATHS = 128;
type BudgetEnv = SlackEnv & {
  STATE: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  };
  SESSIONS?: { config(key: string): Promise<unknown> };
};
type Bin = { minute: number; count: number; refused: number };
type Counts = { seen: number; bins: Bin[] };
type Limits = typeof DEFAULTS;
/** Bounded per-isolate minute bins: no identities, request bodies or raw URLs. */
export function createBudgetRecorder() {
  const paths = new Map<string, Counts>();
  const alerted = new Map<string, number>();
  let config: { at: number; limits: Limits } | undefined;
  let cpuDay = "";
  let cpuMs = 0;
  let flushedAt = -Infinity;
  let queue: Promise<unknown> = Promise.resolve();
  async function settings(env: BudgetEnv, now: number) {
    if (config && now - config.at < WINDOW_MS) return config.limits;
    const limits = { ...DEFAULTS } as Record<keyof Limits, number>;
    await Promise.all(
      Object.keys(DEFAULTS).map(async (name) => {
        const key = name as keyof Limits;
        try {
          const value = await env.SESSIONS?.config(`monitor.${key}`);
          if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1)
            limits[key] = value;
        } catch {
          /* Keep defaults without logging a private service error. */
        }
      }),
    );
    config = { at: now, limits: limits as Limits };
    return config.limits;
  }
  async function alert(env: BudgetEnv, key: string, now: number, text: string) {
    if (now - (alerted.get(key) ?? -Infinity) < REPEAT_MS) return;
    if (await env.STATE.get(`alerted:${key}`)) return;
    await env.STATE.put(`alerted:${key}`, "1", { expirationTtl: REPEAT_MS / 1000 });
    if (alerted.size >= MAX_PATHS * 2 + 1) alerted.delete(alerted.keys().next().value!);
    alerted.set(key, now);
    await post(env, text);
  }
  async function record(env: BudgetEnv, path: string, status: number, cpu: number, now: number) {
    const limits = await settings(env, now);
    for (const [key, value] of paths) if (now - value.seen >= HOUR) paths.delete(key);
    if (!paths.has(path) && paths.size >= MAX_PATHS) paths.delete(paths.keys().next().value!);
    const counts = paths.get(path) ?? { seen: now, bins: [] };
    counts.seen = now;
    const minute = Math.floor(now / MINUTE);
    counts.bins = counts.bins.filter((b) => b.minute > minute - 60);
    let bin = counts.bins.find((b) => b.minute === minute);
    if (!bin) counts.bins.push((bin = { minute, count: 0, refused: 0 }));
    bin.count++;
    if (status === 401) bin.refused++;
    paths.delete(path);
    paths.set(path, counts);
    const rate = counts.bins.reduce((n, b) => n + (b.minute > minute - 10 ? b.count : 0), 0);
    const refused = counts.bins.reduce((n, b) => n + b.refused, 0);
    if (rate > limits.pathRateMax)
      await alert(
        env,
        `path-rate:${path}`,
        now,
        `📈 lianki ${path} 最近十个分钟桶 ${rate} 次请求，超过 ${limits.pathRateMax}（含成功请求；分区近似计数）。`,
      );
    if (refused > limits.repeat401Max)
      await alert(
        env,
        `repeat-401:${path}`,
        now,
        `🔒 lianki ${path} 最近六十个分钟桶 ${refused} 次 401，超过 ${limits.repeat401Max}（分区近似计数）。`,
      );

    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== cpuDay) {
      cpuDay = day;
      cpuMs = 0;
      flushedAt = now;
      const stored = Number(await env.STATE.get(`cpu:${day}`));
      if (Number.isFinite(stored) && stored >= 0) cpuMs = stored;
    }
    if (Number.isFinite(cpu) && cpu >= 0) cpuMs += cpu;
    // At most one write a minute. KV races/isolate eviction make this approximate.
    if (now - flushedAt >= MINUTE) {
      await env.STATE.put(`cpu:${day}`, String(cpuMs), { expirationTtl: 3 * 86400 });
      flushedAt = now;
    }
    const date = new Date(now);
    const days = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    const elapsed = Math.max(HOUR, now - Date.parse(`${day}T00:00:00Z`));
    const projected = Math.round((cpuMs / elapsed) * days * 24 * HOUR);
    if (projected > limits.cpuMsMonthAlert)
      await alert(
        env,
        "cpu-budget",
        now,
        `📊 lianki 本日观察到 CPU ${Math.round(cpuMs)} ms，按本日速率粗略推算整月 ${projected} ms，超过 ${limits.cpuMsMonthAlert} ms。仅主 Worker；KV 并发与休眠可能漏计，不是账单。`,
      );
    return { paths: paths.size, bins: counts.bins.length, rate, refused, cpuMs, projected };
  }
  return (env: BudgetEnv, path: string, status: number, cpu: number, now = Date.now()) => {
    const next = queue.then(() => record(env, path, status, cpu, now));
    queue = next.catch(() => undefined);
    return next;
  };
}
export const recordBudget = createBudgetRecorder();
