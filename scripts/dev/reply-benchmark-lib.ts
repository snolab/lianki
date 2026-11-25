import { laneOfRoute, routeLine } from "../../packages/debug-chat/src/lane-route";
import { isLaneId, laneOf } from "../../packages/debug-chat/src/voices";

type Row = Record<string, unknown>;
type Source = "typed" | "stt";
type Request = { at: number; source: Source };
type Group = {
  lane: string;
  source: Source;
  requests: number;
  matched: number;
  batched: number;
  expired: number;
  censored: number;
  censoredOverTarget: number;
  overTarget: number;
  p50Ms: number | null;
  p90Ms: number | null;
  maxMs: number | null;
};

const row = (v: unknown): Row | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Row) : null;
const timestamp = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Only known lane identifiers escape into output; arbitrary labels/text never do. */
function sender(m: Row, text: string): string | null {
  for (const v of [m.tokenLane, m.lane, m.agentId]) if (isLaneId(v)) return v;
  if (m.label === "Li" || m.agentId === "li") return "main";
  return laneOf({ text }).lane ?? laneOf({ text: `【${String(m.label ?? "")}】` }).lane;
}

/**
 * A bounded historical heuristic, not causal reply linkage or client end-to-end latency.
 * Each response consumes its pending addressed requests once. Multiple pending requests
 * form an ambiguous batch and are excluded from the clean latency percentiles.
 */
export function replyBenchmark(
  input: readonly unknown[],
  options: { thresholdMs: number; windowMs: number; observedAt: number },
) {
  const { thresholdMs, windowMs, observedAt } = options;
  if (
    !Number.isFinite(thresholdMs) ||
    thresholdMs < 0 ||
    !Number.isFinite(windowMs) ||
    windowMs <= 0 ||
    !Number.isFinite(observedAt) ||
    observedAt < 0
  )
    throw Error("Invalid benchmark timing options");
  const groups = new Map<string, Group & { values: number[] }>();
  const pending = new Map<string, { lane: string; requests: Request[] }>();
  const counts = {
    input: input.length,
    invalid: 0,
    ambient: 0,
    automatic: 0,
    unknownAgents: 0,
    batches: 0,
  };
  const get = (lane: string, source: Source) => {
    const key = `${lane}/${source}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        lane,
        source,
        requests: 0,
        matched: 0,
        batched: 0,
        expired: 0,
        censored: 0,
        censoredOverTarget: 0,
        overTarget: 0,
        p50Ms: null,
        p90Ms: null,
        maxMs: null,
        values: [],
      };
      groups.set(key, g);
    }
    return g;
  };
  const messages = input
    .flatMap((v, i) => {
      const m = row(v);
      const at = timestamp(m?.at);
      if (!m || at === null || typeof m.text !== "string" || at > observedAt) {
        counts.invalid++;
        return [];
      }
      return [{ m, at, text: m.text, i }];
    })
    .sort((a, b) => a.at - b.at || a.i - b.i);
  for (const { m, at, text } of messages) {
    const thread = typeof m.thread === "string" ? m.thread : "owner";
    if (m.from === "owner") {
      const routed = routeLine(text);
      const lanes = /^\s*@?(?:Li\b|学习伙伴)[\s，,:：!?！？]/i.test(text)
        ? ["main"]
        : routed.addressed
          ? routed.lanes.map(laneOfRoute)
          : [];
      if (!lanes.length) {
        counts.ambient++;
        continue;
      }
      // Unknown source kinds are not silently classified as typed input.
      if (m.source !== undefined && m.source !== "stt") {
        counts.invalid++;
        continue;
      }
      const source: Source = m.source === "stt" ? "stt" : "typed";
      for (const lane of lanes.filter(isLaneId)) {
        const key = JSON.stringify([thread, lane]);
        const state = pending.get(key) ?? { lane, requests: [] };
        state.requests.push({ at, source });
        pending.set(key, state);
        get(lane, source).requests++;
      }
      continue;
    }
    if (m.from !== "agent" || m.source === "eta" || m.laneEvent) continue;
    const lane = sender(m, text);
    const clean = laneOf({ lane, text }).text;
    if (/^\s*(?:【[^】\n]+】\s*)?收到\s*✓/u.test(clean)) {
      counts.automatic++;
      continue;
    }
    if (!lane) {
      counts.unknownAgents++;
      continue;
    }
    const state = pending.get(JSON.stringify([thread, lane]));
    if (!state) continue;
    const live: Request[] = [];
    for (const req of state.requests) {
      if (at - req.at > windowMs) get(lane, req.source).expired++;
      else live.push(req);
    }
    state.requests = [];
    if (live.length > 1) {
      counts.batches++;
      for (const req of live) get(lane, req.source).batched++;
    } else if (live.length === 1) {
      const req = live[0]!;
      const g = get(lane, req.source);
      const delta = at - req.at;
      g.matched++;
      g.values.push(delta);
      if (delta > thresholdMs) g.overTarget++;
    }
  }
  for (const { lane, requests } of pending.values())
    for (const req of requests) {
      const g = get(lane, req.source);
      if (observedAt - req.at > windowMs) g.expired++;
      else {
        g.censored++;
        if (observedAt - req.at > thresholdMs) g.censoredOverTarget++;
      }
    }
  return {
    method: "addressed-same-lane-first-subsequent-response-heuristic",
    clock: "server message timestamps; excludes client send, network, rendering and speech",
    thresholdMs,
    windowMs,
    observedAt,
    counts,
    groups: [...groups.values()]
      .map(({ values, ...g }) => {
        values.sort((a, b) => a - b);
        return {
          ...g,
          p50Ms: values[Math.ceil(values.length * 0.5) - 1] ?? null,
          p90Ms: values[Math.ceil(values.length * 0.9) - 1] ?? null,
          maxMs: values.at(-1) ?? null,
        };
      })
      .sort((a, b) => a.lane.localeCompare(b.lane) || a.source.localeCompare(b.source)),
    limitations: [
      "No causal reply ID exists in this history; unrelated proactive replies can still match.",
      "Only explicitly addressed requests are counted; ambient and unaddressed lines are excluded.",
      "One reply after multiple pending requests is an ambiguous batch, excluded from percentiles.",
      "Known automatic receipt pattern is excluded; older receipts without a marker may remain.",
      "A bounded history may omit earlier requests or later replies; censored and expired requests are reported separately.",
      "Missing source is typed by the chat protocol; unknown source values are excluded.",
    ],
  };
}
