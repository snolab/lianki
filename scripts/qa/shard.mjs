/**
 * Split the qa:all suites into N shards of about equal running time, for the
 * merge queue's parallel qa jobs (docs/shipping.md, "qa:all in shards").
 *
 * Longest suite first, each onto the shard with the least time so far (LPT);
 * ties go to the lowest shard. Times come from scripts/qa/suite-timings.json
 * (medians from recent CI runs, `bun scripts/qa/record-timings.ts`); a suite
 * not in it counts as DEFAULT_S. A suite tagged `everyShard` (AUDIO-FREE: every
 * other suite relies on its silent layer) runs in every shard and is not
 * counted. Inside a shard the suites keep their order in suites.mjs, and
 * time-sensitive ones still run after the plain ones (gate-suites.ts).
 *
 * Pure and deterministic: every shard job computes the same split on its own.
 */
export const DEFAULT_S = 30;

/** "2/3" → { index: 2, count: 3 }; null for anything else. */
export function parseShard(arg) {
  const m = /^(\d+)\/(\d+)$/.exec(String(arg ?? ""));
  if (!m) return null;
  const index = Number(m[1]);
  const count = Number(m[2]);
  if (count < 1 || index < 1 || index > count) return null;
  return { index, count };
}

/** Every shard's suites, in suites.mjs order: shards[i] is shard i+1. */
export function splitSuites(suites, count, timings = {}) {
  const t = (s) => (typeof timings[s.id] === "number" ? timings[s.id] : DEFAULT_S);
  const pinned = suites.filter((s) => s.everyShard);
  const rest = suites
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => !s.everyShard)
    .sort((a, b) => t(b.s) - t(a.s) || a.i - b.i);
  const load = Array.from({ length: count }, () => 0);
  const picked = Array.from({ length: count }, () => new Set(pinned));
  for (const { s } of rest) {
    let k = 0;
    for (let j = 1; j < count; j++) if (load[j] < load[k]) k = j;
    load[k] += t(s);
    picked[k].add(s);
  }
  return picked.map((set) => suites.filter((s) => set.has(s)));
}

/** Estimated seconds of one shard (pinned suites included). */
export function shardSeconds(shard, timings = {}) {
  return shard.reduce(
    (n, s) => n + (typeof timings[s.id] === "number" ? timings[s.id] : DEFAULT_S),
    0,
  );
}

/** The `qa:all timing <id> <seconds>` lines gate-suites.ts prints, from a CI log. */
export function timingsFromLog(log) {
  const out = {};
  for (const m of log.matchAll(/qa:all timing (\S+) ([\d.]+)/g)) out[m[1]] = Number(m[2]);
  return out;
}

export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
