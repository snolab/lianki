/**
 * The Gantt's categories (owner, 2026-11-10 23:13–23:14 JST;
 * docs/dev-debug-widget.md, "Categories"): the many small timed tasks fold
 * into a few PARENT rows, one per category, and a collapsed parent draws all
 * its children's bars on its one row, overlapping ones in thin lanes
 * (rgui gantt packLanes). The ▸/▾ on the left of a parent expands it (each
 * child its own row again) or folds it back; folded is the default, and
 * what is open is session UI state (ui-store.ts ganttGroupsUi).
 *
 * Which task belongs where is data, not code: the table (gantt-groups.json,
 * the default; a config-store value of the same shape under GANTT_GROUPS_KEY
 * replaces it, checked by parseGroups) maps state-tree path patterns to a
 * category. A pattern is a path ("/words": that node and everything under
 * it) or a path with a trailing "*" ("/chat/gantt*": any id starting so).
 * The most specific (longest) matching pattern wins, so "/chat/gantt*" takes
 * the Gantt's own tasks out of "/chat". An id nothing matches goes to the
 * category marked `fallback`; with none it stays a row of its own. Names are
 * ChatStrings keys (`etaGroup*`, 16 locales with context lines), or, for a
 * category the table adds, its `label` as given.
 *
 * Pure: GanttFull.tsx and EtaBar.tsx's list draw what ganttLines returns.
 */
import { packLanes } from "@snomiao/rgui/gantt";
import { type EtaTask, parkMark } from "./eta";
import table from "./gantt-groups.json";
import { ganttRowsByEnd, rowEnd } from "./gantt-view";

/** One category: its id, its name (a ChatStrings key), the path patterns it takes. */
export type GanttGroupDef = {
  id: string;
  /** A ChatStrings key (etaGroup*); a key the strings lack shows `label`, else the id. */
  name: string;
  match: string[];
  /** Takes every id no other category matches. */
  fallback?: boolean;
  /** The shown name when `name` is not a string key (a category added by config). */
  label?: string;
};

/** The config-store key whose value (the same JSON shape) replaces the default table. */
export const GANTT_GROUPS_KEY = "gantt.groups";

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const isPattern = (p: unknown): p is string =>
  typeof p === "string" && p.startsWith("/") && p.length <= 120 && !/\s/.test(p);

/**
 * A stored table → the categories, each checked; a bad entry is dropped, a
 * repeated id keeps the first, and only the first `fallback` counts. Null
 * when it is not a list at all (keep the default).
 */
export function parseGroups(v: unknown): GanttGroupDef[] | null {
  if (!Array.isArray(v)) return null;
  const out: GanttGroupDef[] = [];
  let fallback = false;
  for (const raw of v.slice(0, 50)) {
    const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    if (typeof o.id !== "string" || !ID.test(o.id) || out.some((g) => g.id === o.id)) continue;
    if (typeof o.name !== "string" || !o.name || o.name.length > 60) continue;
    const match = Array.isArray(o.match) ? o.match.filter(isPattern).slice(0, 100) : [];
    const g: GanttGroupDef = { id: o.id, name: o.name, match };
    if (o.fallback === true && !fallback) g.fallback = fallback = true;
    if (typeof o.label === "string" && o.label && o.label.length <= 60) g.label = o.label;
    if (match.length || g.fallback) out.push(g);
  }
  return out;
}

/** The default table (gantt-groups.json). */
export const GANTT_GROUPS: readonly GanttGroupDef[] = parseGroups(table) ?? [];

/**
 * How specifically `pattern` matches the task id `id`: its length (without
 * the "*"), or -1. "/words" matches "/words" and "/words/…", never
 * "/wordsmith"; "/chat/gantt*" matches any id starting "/chat/gantt".
 */
export function patternScore(pattern: string, id: string): number {
  if (pattern.endsWith("*")) {
    const p = pattern.slice(0, -1);
    return id.startsWith(p) ? p.length : -1;
  }
  const p = pattern.replace(/\/+$/, "");
  return id === p || id.startsWith(`${p}/`) ? p.length : -1;
}

/** The category of a task id: the most specific match (the table's order breaks a tie), else the fallback. */
export function groupOf(id: string, defs: readonly GanttGroupDef[]): GanttGroupDef | null {
  let best: GanttGroupDef | null = null;
  let score = -1;
  for (const g of defs)
    for (const p of g.match) {
      const s = patternScore(p, id);
      if (s > score) {
        score = s;
        best = g;
      }
    }
  return best ?? defs.find((g) => g.fallback) ?? null;
}

/** A category's shown name: its string, else its label, else its id. */
export function groupName(g: GanttGroupDef, strings: object): string {
  const s = (strings as Record<string, unknown>)[g.name];
  return typeof s === "string" && s ? s : (g.label ?? g.id);
}

/** A task's span on the time axis (ms), as its bar is drawn: start → estimate, or on to now / when it finished. */
export function sliceSpan(t: EtaTask, now: number): { from: number; to: number } {
  const from = Math.min(t.start, t.at);
  if (t.done) return { from, to: Math.max(t.at, t.doneAt ?? t.at) };
  // Queued and parked bars stop at their estimate (no overrun is drawn on them).
  if (t.queued || t.parked) return { from, to: t.at };
  return { from, to: Math.max(t.at, now) };
}

/** A task's weight in its parent's progress: its estimate, at least a minute. */
const weight = (t: EtaTask) => Math.max(60_000, t.at - t.start);

/**
 * A parent row as a task of its own (`id` "group:<category>"): from the
 * earliest start to the latest end (a range's P95), its progress the
 * children's reported progress weighted by each estimate (done = 100%),
 * done when all are, queued or parked when every open child is.
 */
export function rollup(id: string, title: string, children: readonly EtaTask[]): EtaTask {
  let w = 0;
  let got = 0;
  for (const t of children) {
    w += weight(t);
    got += weight(t) * (t.done ? 1 : Math.min(100, Math.max(0, t.pct ?? 0)) / 100);
  }
  const open = children.filter((t) => !t.done);
  const done = children.length > 0 && !open.length;
  const doneAts = children.map((t) => t.doneAt ?? t.at);
  const parked = open.length && open.every((t) => t.parked) ? open : null;
  return {
    id: `group:${id}`,
    title,
    start: Math.min(...children.map((t) => Math.min(t.start, t.at))),
    at: Math.max(...children.map((t) => t.at)),
    pct: w ? Math.round((100 * got) / w) : 0,
    ...(done ? { done: true, doneAt: Math.max(...doneAts) } : {}),
    ...(open.length && open.every((t) => t.queued) ? { queued: true } : {}),
    ...(parked
      ? { parked: parked.some((t) => t.parked === "owner") ? "owner" : "blocked" }
      : {}),
  };
}

/** The red mark a parent carries: "!" when any child waits for the owner, else "?" for a decision, else none. */
export function groupMark(children: readonly EtaTask[]): "!" | "?" | null {
  const marks = children.map(parkMark);
  return marks.includes("!") ? "!" : marks.includes("?") ? "?" : null;
}

/** One line of the grouped Gantt: a parent, or a task (a child of an open parent, or one no category takes). */
export type GanttLine =
  | {
      kind: "group";
      key: string;
      def: GanttGroupDef;
      /** The parent as a task (rollup). */
      task: EtaTask;
      /** Its children, by end time; `lane` is each one's lane on the folded row. */
      children: EtaTask[];
      lane: number[];
      lanes: number;
      open: boolean;
      mark: "!" | "?" | null;
    }
  | { kind: "task"; key: string; task: EtaTask; group: string | null };

/**
 * The tasks as lines: each category with tasks is one parent line, sorted
 * among the others (and the tasks no category takes) by end time like the
 * flat rows (gantt-view.ts ganttRowsByEnd: its parent task's latest end);
 * an open parent's children follow it, each its own line, by end time too.
 * `open` holds the expanded category ids. Pass ganttPlan's tasks (queued
 * ones placed).
 */
export function ganttLines(
  tasks: readonly EtaTask[],
  defs: readonly GanttGroupDef[],
  open: readonly string[],
  nameOf: (g: GanttGroupDef) => string,
  now: number,
): GanttLine[] {
  const by = new Map<string, { def: GanttGroupDef; tasks: EtaTask[] }>();
  const loose: EtaTask[] = [];
  for (const t of tasks) {
    const g = groupOf(t.id, defs);
    if (!g) {
      loose.push(t);
      continue;
    }
    const e = by.get(g.id) ?? { def: g, tasks: [] };
    e.tasks.push(t);
    by.set(g.id, e);
  }
  const tops: { task: EtaTask; line: () => GanttLine[] }[] = [];
  for (const { def, tasks: ts } of by.values()) {
    const children = ganttRowsByEnd(ts);
    const task = rollup(def.id, nameOf(def), children);
    const isOpen = open.includes(def.id);
    const { lane, lanes } = packLanes(children.map((t) => sliceSpan(t, now)));
    tops.push({
      task,
      line: () => [
        {
          kind: "group",
          key: task.id,
          def,
          task,
          children,
          lane,
          lanes,
          open: isOpen,
          mark: groupMark(children),
        },
        ...(isOpen
          ? children.map((t) => ({ kind: "task" as const, key: t.id, task: t, group: def.id }))
          : []),
      ],
    });
  }
  for (const t of loose)
    tops.push({ task: t, line: () => [{ kind: "task", key: t.id, task: t, group: null }] });
  return tops
    .sort((a, b) => rowEnd(a.task) - rowEnd(b.task) || a.task.start - b.task.start)
    .flatMap((x) => x.line());
}

/** The line holding task `id`: its own line, else its folded parent's. -1 when it is not there. */
export function lineOf(lines: readonly GanttLine[], id: string): number {
  const own = lines.findIndex((l) => l.kind === "task" && l.task.id === id);
  if (own >= 0) return own;
  return lines.findIndex((l) => l.kind === "group" && l.children.some((t) => t.id === id));
}

/**
 * The thinnest lane on a folded parent row (px; a default for the config
 * store): its lanes share the usual row height while each keeps this much,
 * then the row grows. The lane count itself comes from the data.
 */
export const GANTT_LANE_MIN_PX = 6;

/** A folded parent row's height for `lanes` lanes: the usual `rowH`, taller once each lane would be under the minimum. */
export const groupRowH = (lanes: number, rowH: number, min = GANTT_LANE_MIN_PX) =>
  Math.max(rowH, Math.max(1, lanes) * min);

/** Lane `i` of `n` on a row `rowH` tall: its top and height (px). */
export const laneBox = (i: number, n: number, rowH: number) => {
  const h = rowH / Math.max(1, n);
  return { top: i * h, h };
};

/** Toggle category `id` in the open list (a new list; the order kept). */
export const toggleOpen = (open: readonly string[], id: string): string[] =>
  open.includes(id) ? open.filter((x) => x !== id) : [...open, id];
