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
 * `at`, a done task leaving, the next change of a time-left label (they show
 * whole minutes, rounded up). Re-armed on every change of the tasks; nothing
 * polls. When a task's `at` passes and the hub has not said it pinged
 * (`sent`), `onDue(id)` is called once per (id, at) on this page: the host
 * sends {type:"eta", id} on the progress socket, and the hub (which also has
 * its own alarm) sends the agent at most one line per estimate.
 */
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
 * A short time left: "25m", "1h 5m", "2d 3h" in the page's language (Intl's
 * narrow units, so nothing to translate). `ms` > 0.
 */
export function shortLeft(ms: number, lang?: string): string {
  const unit = (n: number, u: "minute" | "hour" | "day") => {
    try {
      return new Intl.NumberFormat(lang || undefined, {
        style: "unit",
        unit: u,
        unitDisplay: "narrow",
      }).format(n);
    } catch {
      return `${n}${u[0]}`;
    }
  };
  const min = minutesLeft(ms);
  if (min < 60) return unit(Math.max(1, min), "minute");
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${unit(h, "hour")} ${unit(min % 60, "minute")}` : unit(h, "hour");
  const d = Math.floor(h / 24);
  return h % 24 ? `${unit(d, "day")} ${unit(h % 24, "hour")}` : unit(d, "day");
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
    if (left <= 0) continue;
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
