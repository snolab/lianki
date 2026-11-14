/**
 * Status-segmented task bars for the full-screen Gantt chart:
 * tasks are segmented by their status transitions (from progress etaEvents/ticks),
 * each status painted with a dedicated theme-safe oklch colour (never red),
 * displaying status name and elapsed duration on hover / touch.
 */

import { compactSpan, scaleX } from "@snomiao/rgui/gantt";
import type { GanttAxis } from "@snomiao/rgui/gantt";
import type { EtaTask } from "./eta";
import type { EtaTick } from "./state-tree";

export type GanttStatusKey =
  | "doing"
  | "review"
  | "waiting"
  | "waiting-owner"
  | "blocked"
  | "done";

export const GANTT_STATUS_COLORS: Record<
  GanttStatusKey,
  { light: string; dark: string }
> = {
  doing: {
    light: "oklch(0.68 0.12 210 / 0.35)",
    dark: "oklch(0.72 0.12 210 / 0.3)",
  },
  review: {
    light: "oklch(0.62 0.13 285 / 0.35)",
    dark: "oklch(0.68 0.13 285 / 0.3)",
  },
  waiting: {
    light: "oklch(0.75 0.13 85 / 0.35)",
    dark: "oklch(0.78 0.13 85 / 0.3)",
  },
  "waiting-owner": {
    light: "oklch(0.68 0.14 55 / 0.35)",
    dark: "oklch(0.72 0.14 55 / 0.3)",
  },
  blocked: {
    light: "oklch(0.55 0.05 290 / 0.35)",
    dark: "oklch(0.6 0.05 290 / 0.3)",
  },
  done: {
    light: "oklch(0.66 0.15 150 / 0.28)",
    dark: "oklch(0.7 0.14 150 / 0.26)",
  },
};

export const GANTT_STATUS_KEYS: readonly GanttStatusKey[] = [
  "doing",
  "review",
  "waiting",
  "waiting-owner",
  "blocked",
  "done",
] as const;

export const GANTT_STATUS_FALLBACK_LABELS: Record<GanttStatusKey, string> = {
  doing: "doing",
  review: "等 CI / 测试",
  waiting: "等外部 / 队列",
  "waiting-owner": "等主人",
  blocked: "阻塞",
  done: "已完成",
};

export function normalizeGanttStatus(raw?: string): GanttStatusKey {
  if (!raw) return "doing";
  const s = raw.toLowerCase().trim();
  if (s === "done") return "done";
  if (s === "waiting-owner" || s === "waiting_owner") return "waiting-owner";
  if (s === "blocked") return "blocked";
  if (s === "review" || s === "ci" || s === "qa" || s === "test") return "review";
  if (s === "waiting" || s === "queued") return "waiting";
  return "doing";
}

export function formatDuration(ms: number): string {
  const safeMs = Math.max(0, ms);
  if (safeMs < 60_000) {
    const s = Math.round(safeMs / 1000);
    return `${s}s`;
  }
  return compactSpan(safeMs);
}

export type TaskStateSegment = {
  status: GanttStatusKey;
  label: string;
  from: number;
  to: number;
  duration: number;
  durationLabel: string;
  x: number;
  w: number;
  color: string;
};

/**
 * Compute the timeline segments of a task according to its status change history.
 */
export function computeStateSegments(
  task: EtaTask,
  axis: GanttAxis,
  now: number,
  labels?: Partial<Record<GanttStatusKey, string>>,
): TaskStateSegment[] {
  const start = task.start;
  const end = task.done && task.doneAt !== undefined ? task.doneAt : Math.max(start, task.at);
  if (end <= start) return [];

  const rawTicks = (task.ticks ?? []).filter(
    (k: EtaTick): k is EtaTick & { status: string } =>
      k.kind === "status" && typeof k.status === "string",
  );
  // Sort ticks chronologically
  const statusTicks = [...rawTicks].sort((a, b) => a.at - b.at);

  type RawInterval = { status: GanttStatusKey; from: number; to: number };
  const intervals: RawInterval[] = [];

  let curFrom = start;
  // If task has statusTicks, initial status before the first tick
  // If first tick is at start, we use first tick's status; otherwise default initial status
  let curStatus: GanttStatusKey = "doing";
  if (task.queued) curStatus = "waiting";
  else if (task.parked === "owner") curStatus = "waiting-owner";
  else if (task.parked === "blocked") curStatus = "blocked";

  for (const tick of statusTicks) {
    const t = Math.max(start, Math.min(tick.at, end));
    if (t > curFrom) {
      intervals.push({ status: curStatus, from: curFrom, to: t });
      curFrom = t;
    }
    curStatus = normalizeGanttStatus(tick.status);
  }

  if (curFrom < end) {
    // If task is completed, ensure final segment is marked done if task.done
    const finalStatus = task.done ? "done" : curStatus;
    intervals.push({ status: finalStatus, from: curFrom, to: end });
  } else if (intervals.length === 0) {
    const finalStatus = task.done ? "done" : curStatus;
    intervals.push({ status: finalStatus, from: start, to: end });
  }

  // Merge contiguous intervals with the same status
  const merged: RawInterval[] = [];
  for (const iv of intervals) {
    const prev = merged[merged.length - 1];
    if (prev && prev.status === iv.status) {
      prev.to = Math.max(prev.to, iv.to);
    } else {
      merged.push({ ...iv });
    }
  }

  return merged.map((m) => {
    const x0 = scaleX(axis, m.from, now);
    const x1 = scaleX(axis, m.to, now);
    const x = Math.min(x0, x1);
    const w = Math.max(1, Math.abs(x1 - x0));
    const duration = Math.max(0, m.to - m.from);
    const color = `light-dark(${GANTT_STATUS_COLORS[m.status].light}, ${GANTT_STATUS_COLORS[m.status].dark})`;
    const label = labels?.[m.status] ?? GANTT_STATUS_FALLBACK_LABELS[m.status];
    return {
      status: m.status,
      label,
      from: m.from,
      to: m.to,
      duration,
      durationLabel: formatDuration(duration),
      x,
      w,
      color,
    };
  });
}
