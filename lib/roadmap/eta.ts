/**
 * When will a step, and the whole roadmap, be done at the learner's own
 * pace? From their learning log over a recent window (config
 * `roadmap.paceWindowDays`): new words learned a day for a deck step,
 * checklist items ticked a day for a doc step. The rate weighs recent days
 * more (day i of the window, oldest first, weighs i + 1), so a learner who
 * speeds up sees it soon. Fewer active days than `roadmap.paceMinActiveDays`
 * is "too little history" — no guess. Days are UTC days. Pure, no I/O: the
 * server measures, the page recomputes at once when the target date moves.
 *
 * The whole roadmap follows the notation (lib/roadmap/notation.ts): a stage
 * takes as long as its slowest lane, stages add up.
 */
import type { ProgressUnit, StepMeasure } from "@/types/roadmap";
import { stages, type Staged } from "./notation";

const DAY = 86_400_000;

/** YYYY-MM-DD of a time, UTC. */
export const utcDay = (t: number | Date): string => new Date(t).toISOString().slice(0, 10);

/** The day `n` days after YYYY-MM-DD `day`. */
export const addDays = (day: string, n: number): string =>
  utcDay(Date.parse(`${day}T00:00:00Z`) + n * DAY);

/** Whole days from `from` to `to` (YYYY-MM-DD each); negative when `to` is earlier. */
export const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);

/** Counts per day for the `windowDays` days ending `today`, oldest first. */
export function dailyCounts(
  byDay: Record<string, number> | Iterable<string>,
  today: string,
  windowDays: number,
): number[] {
  const counts = new Map<string, number>();
  if (typeof (byDay as Iterable<string>)[Symbol.iterator] === "function") {
    for (const t of byDay as Iterable<string>) {
      const ms = Date.parse(t);
      if (Number.isFinite(ms)) counts.set(utcDay(ms), (counts.get(utcDay(ms)) ?? 0) + 1);
    }
  } else for (const [d, n] of Object.entries(byDay)) counts.set(d, Number(n) || 0);
  const out: number[] = [];
  for (let i = windowDays - 1; i >= 0; i--) out.push(counts.get(addDays(today, -i)) ?? 0);
  return out;
}

/** Units a day, recent days weighted more. 0 for an empty window. */
export function paceRate(daily: readonly number[]): number {
  let num = 0;
  let den = 0;
  daily.forEach((c, i) => {
    num += (i + 1) * Math.max(0, c);
    den += i + 1;
  });
  return den ? num / den : 0;
}

export type Eta =
  | { kind: "done" }
  /** Nothing to measure (a doc without checkboxes, a keyword step): no estimate. */
  | { kind: "na" }
  | { kind: "too-little"; activeDays: number }
  | {
      kind: "eta";
      days: number;
      date: string;
      rate: number;
      remaining: number;
      unit: ProgressUnit;
    };

export type PaceSettings = { today: string; minActiveDays: number };

/** One step's estimate from its measure. */
export function stepEta(m: StepMeasure | undefined, p: PaceSettings): Eta {
  if (!m || m.total === null) return { kind: "na" };
  const remaining = Math.max(0, m.total - m.done);
  if (m.total > 0 && remaining === 0) return { kind: "done" };
  if (m.total === 0 || !m.daily) return { kind: "na" };
  const activeDays = m.daily.filter((c) => c > 0).length;
  const rate = paceRate(m.daily);
  if (activeDays < p.minActiveDays || !(rate > 0)) return { kind: "too-little", activeDays };
  const days = Math.max(1, Math.ceil(remaining / rate));
  return { kind: "eta", days, date: addDays(p.today, days), rate, remaining, unit: m.unit };
}

export type RoadmapEta =
  | { kind: "done" }
  | { kind: "na" }
  | { kind: "too-little"; steps: number }
  | {
      kind: "eta";
      days: number;
      date: string;
      /** What is left, per unit, and the current pace per unit (for "need ~X/day"). */
      remaining: Partial<Record<ProgressUnit, number>>;
      rate: Partial<Record<ProgressUnit, number>>;
    };

/**
 * The whole roadmap: each stage lasts as long as its slowest unfinished
 * lane; stages add up. Steps with nothing to measure are left out; one
 * unfinished step with too little history makes the whole "too little".
 */
export function roadmapEta<T extends Staged & { measure?: StepMeasure }>(
  nodes: readonly T[],
  p: PaceSettings,
): RoadmapEta {
  let days = 0;
  let measured = 0;
  let unknown = 0;
  const remaining: Partial<Record<ProgressUnit, number>> = {};
  const rate: Partial<Record<ProgressUnit, number>> = {};
  for (const group of stages(nodes)) {
    let longest = 0;
    for (const n of group) {
      const e = stepEta(n.measure, p);
      if (e.kind === "na") continue;
      measured++;
      if (e.kind === "too-little") unknown++;
      if (e.kind === "eta") {
        longest = Math.max(longest, e.days);
        remaining[e.unit] = (remaining[e.unit] ?? 0) + e.remaining;
        rate[e.unit] = (rate[e.unit] ?? 0) + e.rate;
      }
    }
    days += longest;
  }
  if (!measured) return { kind: "na" };
  if (unknown) return { kind: "too-little", steps: unknown };
  if (days === 0) return { kind: "done" };
  return { kind: "eta", days, date: addDays(p.today, days), remaining, rate };
}

export type PaceState = "on-pace" | "ahead" | "behind" | "no-data";

export type PaceVerdict =
  | { state: "no-target" }
  | { state: "no-data"; target: string }
  | { state: "on-pace"; target: string; slack: number }
  | { state: "ahead"; target: string; by: number }
  | {
      state: "behind";
      target: string;
      by: number;
      /** Units a day needed from today to finish by the target. */
      need: Partial<Record<ProgressUnit, number>>;
    };

/**
 * The roadmap's estimate against the learner's target date. Finishing at
 * least `aheadDays` early is "ahead", by the target "on pace", later
 * "behind by N days" with the daily amount that would make it. Recomputed in
 * the page whenever the target moves.
 */
export function paceVerdict(
  eta: RoadmapEta,
  target: string | null | undefined,
  today: string,
  aheadDays: number,
): PaceVerdict {
  if (!target) return { state: "no-target" };
  const left = daysBetween(today, target);
  if (eta.kind === "done") return { state: "ahead", target, by: Math.max(0, left) };
  if (eta.kind !== "eta") return { state: "no-data", target };
  const slack = left - eta.days;
  if (slack >= Math.max(1, aheadDays)) return { state: "ahead", target, by: slack };
  if (slack >= 0) return { state: "on-pace", target, slack };
  const need: Partial<Record<ProgressUnit, number>> = {};
  for (const [u, r] of Object.entries(eta.remaining) as [ProgressUnit, number][])
    if (r > 0) need[u] = Math.ceil(r / Math.max(1, left));
  return { state: "behind", target, by: -slack, need };
}

/**
 * The secondary percentage: the mean share done over the steps that can be
 * counted (a doc without checklist and a step with nothing to count are
 * left out). Null when no step can be counted.
 */
export function overallShare(nodes: readonly { measure?: StepMeasure }[]): number | null {
  const shares = nodes.flatMap((n) =>
    n.measure && n.measure.total ? [Math.min(1, n.measure.done / n.measure.total)] : [],
  );
  return shares.length ? shares.reduce((a, b) => a + b, 0) / shares.length : null;
}
