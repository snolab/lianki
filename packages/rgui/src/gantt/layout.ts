/**
 * rgui gantt — task rows → laid-out bars, with semantic-zoom LOD (pure).
 *
 * Each task's bar is projected on the scale end by end (on the log axis a bar
 * is not a shifted copy). Then rgui's LOD rule (core/rule.ts, core/lod.ts):
 * what cannot be drawn readably is not dropped but replaced by a readable
 * abstraction. A run of consecutive rows whose bars are all too thin to read
 * (far from Now on the log axis, or zoomed out) and lie within the cluster
 * gap of each other coarse-grains into ONE pseudo-row: "first name… ×N",
 * its bar the union of theirs. Rows a host must keep (open tasks, by default)
 * never fold. Labels stay readable at every zoom: a row's label is its own
 * name, a cluster's is the first member's name and the count (lane/treefold
 * chunkRows' label for a multi-entry chunk).
 *
 * Rendering is the host's: these are numbers in px on the scale's content,
 * plus `windowRows`, the slice of rows a windowed list should draw.
 */
import { resolveRule, type RgRule } from "../core/rule";
import { chunkRows } from "../lane/treefold";
import { clamp, scaleWidth, scaleX, type GanttAxis } from "./scale";

/** What a Gantt row needs: when it starts, its estimate, and how it ended. */
export type GanttTask = {
  start: number;
  at: number;
  pct?: number;
  done?: boolean;
  doneAt?: number;
};

/** A Gantt row, in px on the axis: the planned bar, its progress, the overrun. */
export type GanttBar = {
  x: number;
  w: number;
  /** The progress fill, px from the bar's start. */
  fill: number;
  /** The overrun past the estimate: from x + w, this wide. */
  over: number;
};

/**
 * One task's bar on the axis (px), clamped to the content [0, width]: from
 * its start to its estimate, the progress (pct; a done one all of it) inside,
 * past the estimate the overrun on to now (or to when it finished late).
 */
export function ganttBar(t: GanttTask, a: GanttAxis, now: number): GanttBar {
  const width = scaleWidth(a);
  const x = (ms: number) => clamp(scaleX(a, ms, now), 0, width);
  const x0 = x(Math.min(t.start, t.at));
  const x1 = x(t.at);
  const end = t.done ? x(t.doneAt ?? t.at) : x(now);
  const pct = t.done ? 100 : clamp(t.pct ?? 0, 0, 100);
  const w = x1 - x0;
  return { x: x0, w, fill: (w * pct) / 100, over: Math.max(0, end - x1) };
}

/**
 * The rows in display order: open ones first, by start (then estimate); then
 * the done, the latest finished first (the history the axis scrolls into).
 */
export function ganttRows<T extends GanttTask>(planned: readonly T[]): T[] {
  const open = planned.filter((t) => !t.done).sort((a, b) => a.start - b.start || a.at - b.at);
  const done = planned
    .filter((t) => t.done)
    .sort((a, b) => (b.doneAt ?? b.at) - (a.doneAt ?? a.at));
  return [...open, ...done];
}

/** The tasks' time range (earliest start, latest end), or now..now with none. */
export function rowsRange(rows: readonly GanttTask[], now: number): { from: number; to: number } {
  if (!rows.length) return { from: now, to: now };
  return {
    from: Math.min(...rows.map((t) => Math.min(t.start, t.at))),
    to: Math.max(...rows.map((t) => (t.done && t.doneAt !== undefined ? t.doneAt : t.at))),
  };
}

/** A bar narrower than this (its overrun included) cannot be read or tapped (px). */
export const READABLE_BAR_PX = 6;

/** A laid-out row: one task, or a cluster pseudo-row of several. */
export type GanttItem<T> =
  | { kind: "row"; index: number; task: T; bar: GanttBar }
  | {
      kind: "cluster";
      /** The members' indices in the input: [from, to). */
      from: number;
      to: number;
      tasks: T[];
      /** The union of the members' bars (px). */
      x: number;
      w: number;
      count: number;
      /** How many members are done. */
      done: number;
      /** The first member's name and "…" (lane/treefold chunkRows). */
      label: string;
    };

export type GanttLayoutOptions<T> = {
  /** A row's name, for a cluster's label. */
  name?: (t: T) => string;
  /** Rows that never fold (default: open tasks). */
  keep?: (t: T) => boolean;
  /** Bars under this many px are unreadable (READABLE_BAR_PX). */
  minBarPx?: number;
  /** The rg-rule: clusterGapPx is the screen gap two bars may have and still merge. */
  rule?: Partial<RgRule>;
  /** The fewest rows a cluster takes (default 2: one thin row stays itself). */
  minRun?: number;
};

const span = (b: GanttBar) => ({ x0: b.x, x1: b.x + b.w + b.over });

/**
 * Lay the rows out on the axis: every row's bar, with consecutive unreadable
 * rows close together on screen coarse-grained into cluster pseudo-rows.
 */
export function layoutGantt<T extends GanttTask>(
  rows: readonly T[],
  a: GanttAxis,
  now: number,
  opts: GanttLayoutOptions<T> = {},
): GanttItem<T>[] {
  const rule = resolveRule(opts.rule);
  const minBar = opts.minBarPx ?? READABLE_BAR_PX;
  const keep = opts.keep ?? ((t: T) => !t.done);
  const name = opts.name ?? ((_: T) => "");
  const minRun = Math.max(2, opts.minRun ?? 2);
  const bars = rows.map((t) => ganttBar(t, a, now));
  const out: GanttItem<T>[] = [];
  const thin = (i: number) => {
    const s = span(bars[i]!);
    return !keep(rows[i]!) && s.x1 - s.x0 < minBar;
  };
  let i = 0;
  while (i < rows.length) {
    if (!thin(i)) {
      out.push({ kind: "row", index: i, task: rows[i]!, bar: bars[i]! });
      i++;
      continue;
    }
    // Grow the run while the next thin bar is within the gap of the run's span.
    let { x0, x1 } = span(bars[i]!);
    let j = i + 1;
    while (j < rows.length && thin(j)) {
      const s = span(bars[j]!);
      if (s.x0 > x1 + rule.clusterGapPx || s.x1 < x0 - rule.clusterGapPx) break;
      x0 = Math.min(x0, s.x0);
      x1 = Math.max(x1, s.x1);
      j++;
    }
    if (j - i < minRun) {
      for (let k = i; k < j; k++) out.push({ kind: "row", index: k, task: rows[k]!, bar: bars[k]! });
    } else {
      const tasks = rows.slice(i, j);
      out.push({
        kind: "cluster",
        from: i,
        to: j,
        tasks,
        x: x0,
        w: x1 - x0,
        count: tasks.length,
        done: tasks.filter((t) => t.done).length,
        label: chunkRows(tasks.map(name), 1)[0]!.label,
      });
    }
    i = j;
  }
  return out;
}

/**
 * The rows a windowed list draws: those within `overscan` rows of the view
 * (scrollTop, viewPx) for rows `rowPx` tall, [start, end). Bounded by the
 * view, not the list: the DOM stays the same size however long the history.
 */
export function windowRows(
  count: number,
  rowPx: number,
  scrollTop: number,
  viewPx: number,
  overscan = 4,
): { start: number; end: number } {
  if (count <= 0 || !(rowPx > 0)) return { start: 0, end: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / rowPx);
  const last = Math.ceil((Math.max(0, scrollTop) + Math.max(0, viewPx)) / rowPx);
  return {
    start: clamp(first - overscan, 0, count),
    end: clamp(last + overscan, 0, count),
  };
}
