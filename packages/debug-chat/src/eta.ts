/**
 * The ETA bar (docs/dev-debug-widget.md, "ETA bar"): every state-tree node an
 * agent gave an estimate (`progress.ts --eta`, lib/progress.ts etaAt) is a
 * timed task. The chat shows one summary bar above the input (EtaBar.tsx);
 * the state tree (the status area, opened from the + menu or by tapping the
 * bar) lists each task with its own bar and time left.
 *
 * Pure parts and the page's one timer. Progress is time against the estimate:
 * a task started at `start` and due at `at` is (now − start) / (at − start),
 * at most 1; a done one is 1. The summary weighs each task by its estimate.
 * A done task stays LINGER_MS, then leaves.
 *
 * The timer (etaClock): one per page, armed to the soonest of: a task's
 * `at`, a done task leaving, the next change of a time label (compactTime:
 * whole minutes, rounded up, counting on past due). Re-armed on every change of the tasks; nothing
 * polls. When a task's `at` passes and the hub has not said it pinged
 * (`sent`), `onDue(id)` is called once per (id, at) on this page: the host
 * sends {type:"eta", id} on the progress socket, and the hub (which also has
 * its own alarm) sends the agent at most one line per estimate.
 */
import { compactSpan } from "@snomiao/rgui/gantt";
import type { TreeEta, TreeNode } from "./state-tree";

/** A done task stays this long, then leaves the bar and the list. */
export const LINGER_MS = 8_000;
/** The shortest estimate weight, so a task due at once still counts. */
const MIN_WEIGHT_MS = 60_000;

export type EtaTask = TreeEta & { title: string; status?: TreeNode["status"] };

/** Every timed task in the tree, soonest first. */
export function etaTasks(root: TreeNode | null | undefined): EtaTask[] {
  const out: EtaTask[] = [];
  const walk = (n: TreeNode) => {
    if (n.eta) out.push({ ...n.eta, title: n.title, ...(n.status ? { status: n.status } : {}) });
    for (const c of n.children) walk(c);
  };
  if (root) walk(root);
  return out.sort((a, b) => a.at - b.at);
}

/** Shown now: open tasks, and done ones for LINGER_MS after they finished. */
export function shownTasks(tasks: readonly EtaTask[], now: number): EtaTask[] {
  return tasks.filter((t) => !t.done || (t.doneAt !== undefined && now - t.doneAt < LINGER_MS));
}

/** How far along a task is, 0–1. */
export function taskFraction(t: EtaTask, now: number): number {
  if (t.done) return 1;
  const span = t.at - t.start;
  if (span <= 0) return now >= t.at ? 1 : 0;
  return Math.min(1, Math.max(0, (now - t.start) / span));
}

export type EtaSummary = {
  /** Tasks shown (open and lingering done). */
  count: number;
  open: number;
  /** Weighted by each estimate, 0–100. */
  pct: number;
  /** Until the last open task's estimate runs out; ≤ 0 = all are past. Null: none open. */
  leftMs: number | null;
  /** The soonest estimate still ahead. */
  next: EtaTask | null;
  /** The one task, when there is one. */
  only: EtaTask | null;
};

export function etaSummary(tasks: readonly EtaTask[], now: number): EtaSummary {
  const shown = shownTasks(tasks, now);
  const open = shown.filter((t) => !t.done);
  let w = 0;
  let got = 0;
  for (const t of shown) {
    const weight = Math.max(MIN_WEIGHT_MS, t.at - t.start);
    w += weight;
    got += weight * taskFraction(t, now);
  }
  const last = open.reduce((m, t) => Math.max(m, t.at), -Infinity);
  return {
    count: shown.length,
    open: open.length,
    pct: w ? Math.round((100 * got) / w) : 0,
    leftMs: open.length ? last - now : null,
    next: open.filter((t) => t.at > now).sort((a, b) => a.at - b.at)[0] ?? null,
    only: shown.length === 1 ? shown[0]! : null,
  };
}

/** Whole minutes left, rounded up (what a label shows); 0 once due. */
export const minutesLeft = (ms: number) => (ms <= 0 ? 0 : Math.ceil(ms / 60_000));

/**
 * Every time label of the bar, the list and the minimized line, in one
 * language-neutral form (owner, 2026-11-08 20:34 JST): under an hour "<n>M"
 * (whole minutes, rounded up: "5M", "40M"); from an hour the largest unit it
 * reaches, to one decimal, a whole number without it: hours ("1H", "1.5H"
 * for 1 h 29 min), then days, weeks, months, years ("1.5D", "2W", "3Mo",
 * "1.2Y"; owner, 2026-11-10: over a year is Y, not D). One formatter with
 * the Gantt's axis labels (rgui gantt compactSpan). Past due it is negative
 * ("-5M", "-1.5H"), drawn red (EtaBar.tsx).
 */
export function compactTime(ms: number): string {
  const min = minutesLeft(Math.abs(ms));
  const sign = ms < 0 && min > 0 ? "-" : "";
  // One formatter with the Gantt's axis (rgui compactSpan): Y, Mo, W, D, H, M by size.
  return `${sign}${compactSpan(min * 60_000, min)}`;
}

/** Parked on a person (TreeEta.parked): no work runs, its time is a reminder. */
export const isParked = (t: { done?: boolean; parked?: string }) => !t.done && !!t.parked;

/** The red mark before a task that waits for the owner: "?" for a decision, else "!"; none otherwise. */
export const parkMark = (t: { done?: boolean; parked?: string; question?: boolean }) =>
  !t.done && t.parked === "owner" ? (t.question ? "?" : "!") : null;

/** Past due: a negative label, drawn red. */
export const isLate = (ms: number) => compactTime(ms).startsWith("-");

/**
 * The Gantt list's shared time axis (owner, 2026-11-09 01:39 JST): the left
 * edge is the earliest start of a shown task, the right edge the latest end
 * (its estimate, or when a done one finished; queued tasks at their computed
 * ends — pass ganttPlan's tasks). It rescales whenever the tasks change; now
 * is placed on it, clamped to an edge when outside (ganttRow). An empty
 * range is widened to GANTT_MIN_SPAN_MS.
 */
export type GanttWindow = { lo: number; hi: number };
export const GANTT_MIN_SPAN_MS = 60_000;
/**
 * Where the Gantt list draws each task (owner, 2026-11-09 01:38 JST): running
 * tasks as they are, overlapping freely; queued ones (`queued`, status
 * waiting) one after another, in order of creation: the first starts when the
 * soonest running task is due (or now, if that is past or none runs), each
 * next one when the one ahead is expected to finish; a queued bar is
 * `queuedMs` long. Display only: the hub's estimates and pings keep `at`.
 */
export function ganttPlan(tasks: readonly EtaTask[], now: number): EtaTask[] {
  const running = tasks.filter((t) => !t.done && !t.queued);
  let next = Math.max(now, running.length ? Math.min(...running.map((t) => t.at)) : now);
  const placed = new Map<string, EtaTask>();
  const queue = tasks
    .filter((t) => t.queued && !t.done)
    .sort((a, b) => (a.created ?? a.start) - (b.created ?? b.start));
  for (const t of queue) {
    const len = Math.max(60_000, t.queuedMs ?? t.at - t.start);
    placed.set(t.id, { ...t, start: next, at: next + len });
    next += len;
  }
  return tasks.map((t) => placed.get(t.id) ?? t);
}

export function ganttWindow(tasks: readonly EtaTask[], now: number): GanttWindow | null {
  const shown = shownTasks(tasks, now);
  if (!shown.length) return null;
  const lo = Math.min(...shown.map((t) => Math.min(t.start, t.at)));
  const hi = Math.max(...shown.map((t) => (t.done && t.doneAt !== undefined ? t.doneAt : t.at)));
  return { lo, hi: Math.max(hi, lo + GANTT_MIN_SPAN_MS) };
}

/**
 * One row's bar on the axis, each in percent of the row's width: it starts
 * at `left` (the task's start) and runs `plan` to its estimate; `fill` is how
 * much of the planned part its progress covers (pct; a done task all of it);
 * past the estimate, `over` runs on to now (or to when it finished late).
 * `now` is where now is. No numbers are drawn: the bar is the timing.
 */
export type GanttRow = { left: number; plan: number; fill: number; over: number; now: number };
export function ganttRow(t: EtaTask, w: GanttWindow, now: number): GanttRow {
  const x = (ms: number) => Math.min(100, Math.max(0, ((ms - w.lo) / (w.hi - w.lo)) * 100));
  const left = x(t.start);
  const due = x(t.at);
  const end = t.done ? x(t.doneAt ?? t.at) : x(now);
  const pct = t.done ? 100 : Math.min(100, Math.max(0, t.pct ?? 0));
  return { left, plan: Math.max(0, due - left), fill: pct, over: Math.max(0, end - due), now: x(now) };
}

/** The tasks due now that this page should report: open, past `at`, not sent. */
export function dueTasks(tasks: readonly EtaTask[], now: number): EtaTask[] {
  return tasks.filter((t) => !t.done && !t.sent && t.at <= now);
}

/** When this page's one timer should go off next (absolute ms), or null for no timer. */
export function nextWake(tasks: readonly EtaTask[], now: number): number | null {
  let wake = Infinity;
  for (const t of tasks) {
    if (t.done) {
      if (t.doneAt !== undefined && now - t.doneAt < LINGER_MS)
        wake = Math.min(wake, t.doneAt + LINGER_MS);
      continue;
    }
    const left = t.at - now;
    if (left <= 0) {
      // Past due, its label counts on ("-1M", "-2M"…): the next whole minute past.
      // On a whole minute ("0M" at the estimate, "-1M" at one over), it changes right after.
      const into = -left % 60_000;
      wake = Math.min(wake, now + (into === 0 ? 1 : 60_000 - into));
      continue;
    }
    wake = Math.min(wake, t.at);
    // The label shows minutes rounded up: it changes when `left` crosses the next whole minute.
    const step = left - (minutesLeft(left) - 1) * 60_000;
    wake = Math.min(wake, now + step);
  }
  return wake === Infinity ? null : wake;
}

export type EtaClockDeps = {
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (t: unknown) => void;
  /** A task's estimate ran out and the hub has not said it pinged: tell it (once per id and at). */
  onDue: (id: string) => void;
  /** The clock moved past a change: render again. */
  onTick: (now: number) => void;
};

/** The page's one ETA timer: `update(tasks)` on every change re-arms it; `stop()` ends it. */
export function etaClock(deps: EtaClockDeps) {
  const now = deps.now ?? Date.now;
  const later = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = deps.clearTimeout ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let timer: unknown;
  let tasks: readonly EtaTask[] = [];
  /** `${id}@${at}` reported from this page: one report per estimate. */
  const reported = new Set<string>();
  let stopped = false;
  const report = (t: number) => {
    for (const d of dueTasks(tasks, t)) {
      const key = `${d.id}@${d.at}`;
      if (reported.has(key)) continue;
      reported.add(key);
      deps.onDue(d.id);
    }
  };
  const arm = () => {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
    if (stopped) return;
    const t = now();
    const wake = nextWake(tasks, t);
    if (wake === null) return;
    timer = later(fire, Math.max(0, wake - t));
  };
  const fire = () => {
    timer = undefined;
    const t = now();
    report(t);
    deps.onTick(t);
    arm();
  };
  return {
    update(next: readonly EtaTask[]) {
      tasks = next;
      // A page opened after an estimate ran out reports it at once (the hub dedupes).
      report(now());
      arm();
    },
    stop() {
      stopped = true;
      if (timer !== undefined) cancel(timer);
      timer = undefined;
    },
    /** Armed (for tests): is a timer set. */
    armed: () => timer !== undefined,
  };
}

/**
 * A task title is "name: description" (owner, 2026-11-08; ASCII ':' or
 * full-width '：'). The bar and the minimized chat show the name only; the
 * state tree's list shows both. No colon: it is all name. An empty name
 * (a title starting with a colon) falls back to the description.
 */
export function splitTitle(title: string): { name: string; desc: string } {
  const i = title.search(/[:：]/);
  if (i < 0) return { name: title.trim(), desc: "" };
  const name = title.slice(0, i).trim();
  const desc = title.slice(i + 1).trim();
  return name ? { name, desc } : { name: desc, desc: "" };
}

/** Is `a` an ancestor of `b` by path id ("/words" of "/words/swipe")? */
const ancestorOf = (a: string, b: string) =>
  a !== b && a.startsWith("/") && b.startsWith(a.endsWith("/") ? a : `${a}/`);
const depthOf = (id: string) => (id.startsWith("/") ? id.split("/").filter(Boolean).length : 0);

/**
 * The minimized chat's two ends (owner, 2026-11-08 20:07 JST): the smallest
 * unit, the soonest open leaf (an open task with no open task under it), and
 * the largest, the open task whose estimate runs out last (the shallower on a
 * tie). One open task, or both the same: `big` only. None open: null.
 */
export function etaEnds(
  tasks: readonly EtaTask[],
): { small?: EtaTask; big: EtaTask } | null {
  const open = tasks.filter((t) => !t.done);
  if (!open.length) return null;
  const leaves = open.filter((a) => !open.some((b) => ancestorOf(a.id, b.id)));
  const small = (leaves.length ? leaves : open).reduce((x, y) => (y.at < x.at ? y : x));
  const big = open.reduce((x, y) =>
    y.at > x.at || (y.at === x.at && depthOf(y.id) < depthOf(x.id)) ? y : x,
  );
  return small.id === big.id ? { big } : { small, big };
}

/**
 * One end's part of the minimized line: the task's name and its time left
 * (compactTime); `late` when past due (drawn red).
 */
export type EtaPart = { name: string; min: string; late?: boolean };

/** The minimized line's parts, "<small> 5M · <big> 1.5H". Null without an open timed task. */
export function etaParts(tasks: readonly EtaTask[], now: number): EtaPart[] | null {
  const ends = etaEnds(tasks);
  if (!ends) return null;
  const part = (t: EtaTask): EtaPart => ({
    name: splitTitle(t.title).name,
    min: compactTime(t.at - now),
    ...(isLate(t.at - now) ? { late: true } : {}),
  });
  return ends.small ? [part(ends.small), part(ends.big)] : [part(ends.big)];
}

/** The parts as one line of text (the title and the screen-reader label). */
export const etaPartsText = (parts: readonly EtaPart[]) =>
  parts.map((p) => `${p.name} ${p.min}`).join(" · ");
