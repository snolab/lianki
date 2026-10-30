/**
 * The pure parts of `scripts/dev/voice-latency.ts`: find the page's
 * `{ev: "voice-latency", …}` records (packages/debug-chat/src/latency.ts) in
 * whatever `wrangler tail lianki` prints, and summarize them per stage.
 * Tested in unit/voice-latency.test.ts.
 */

/** The stages, in path order (latency.ts Breakdown). */
export const STAGES = [
  "vadMs",
  "encodeMs",
  "sttMs",
  "sttServerMs",
  "sttNetMs",
  "waitMs",
  "sendMs",
  "hubMs",
  "ackMs",
  "agentMs",
  "voiceMs",
  "replyMs",
  "totalMs",
] as const;
export type Stage = (typeof STAGES)[number];
export type LatencyEvent = { id?: string; replied?: boolean } & Partial<Record<Stage, number>>;

/**
 * Feed it text in any chunks; it calls `on` with every top-level JSON object
 * in it (wrangler's --format json events, pretty-printed or not, or JSON
 * embedded in --format pretty lines). Text between objects is skipped.
 */
export function jsonScanner(on: (v: unknown) => void) {
  let buf = "";
  let depth = 0;
  let inStr = false;
  let esc = false;
  return (chunk: string) => {
    for (const ch of chunk) {
      if (depth === 0) {
        if (ch !== "{") continue;
        buf = "";
      }
      buf += ch;
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          on(JSON.parse(buf));
        } catch {}
        buf = "";
      }
    }
  };
}

const parse = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

/**
 * The voice-latency records in one parsed object, however deep: the event
 * itself, a `dev.client` log line (its `body` is the page's JSON), or a tail
 * event whose log messages hold such lines.
 */
export function latencyEvents(v: unknown, out: LatencyEvent[] = []): LatencyEvent[] {
  if (typeof v === "string") {
    const t = v.trim();
    if (t.startsWith("{")) latencyEvents(parse(t), out);
    return out;
  }
  if (Array.isArray(v)) {
    for (const x of v) latencyEvents(x, out);
    return out;
  }
  if (!v || typeof v !== "object") return out;
  const o = v as Record<string, unknown>;
  if (o.ev === "voice-latency") {
    out.push(o as LatencyEvent);
    return out;
  }
  for (const x of Object.values(o)) latencyEvents(x, out);
  return out;
}

/** The q-quantile (0..1) of sorted numbers, by nearest rank. */
export function quantile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return Number.NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

export type StageRow = { stage: Stage; n: number; median: number; p90: number; mean: number };

/** One row per stage seen at least once: how many samples, median, p90 and mean, in ms. */
export function summarize(events: readonly LatencyEvent[]): StageRow[] {
  const rows: StageRow[] = [];
  for (const stage of STAGES) {
    const xs = events
      .map((e) => e[stage])
      .filter((x): x is number => typeof x === "number" && Number.isFinite(x))
      .sort((a, b) => a - b);
    if (!xs.length) continue;
    rows.push({
      stage,
      n: xs.length,
      median: quantile(xs, 0.5),
      p90: quantile(xs, 0.9),
      mean: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length),
    });
  }
  return rows;
}

/** The summary as a markdown table. */
export function table(rows: readonly StageRow[]): string {
  const head = "| stage | n | median ms | p90 ms | mean ms |\n| --- | --: | --: | --: | --: |";
  return [
    head,
    ...rows.map((r) => `| ${r.stage} | ${r.n} | ${r.median} | ${r.p90} | ${r.mean} |`),
  ].join("\n");
}
