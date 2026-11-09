/**
 * /dev/roadmap from the state tree (docs/planning-tools.md, step 4): the open
 * nodes of the live tree and the hub's done history, sorted into sections and
 * grouped by top-level path. No list of its own — every item is a hub node.
 *
 *   roadmapSections   pure: rows + history → sections of groups of items
 *   roadmapSource     the owner's progress socket: the snapshot, live events,
 *                     and the done history it asks for ({type:"history"})
 */
import {
  type ProgressEntry,
  type ProgressHistory,
  type ProgressView,
  applyProgressMessage,
  isOwnerTodo,
  isPathId,
  openTodoRefs,
  parseHistoryMessage,
  parseProgressMessage,
  progressHistory,
  prsOf,
  waitsOnOwner,
} from "./progress";
import { GIVE_UP, MAX_DELAY, type Sock, browserWake } from "./progress-tree";

/** Page order: built now, waits on the owner, open but not started, shipped (folded). */
export const ROADMAP_SECTIONS = ["doing", "waiting", "queued", "done"] as const;
export type RoadmapSection = (typeof ROADMAP_SECTIONS)[number];

export type RoadmapItem = {
  id: string;
  /** The node's title, as written (one language, free text). */
  title: string;
  prs: number[];
  link?: string;
  /** Open: when its estimate runs out. */
  etaAt?: number;
  /** Open: what the owner must do. */
  needs?: string;
  /** Done: when; open: the last write. Sorts newest first. */
  at: number;
};
export type RoadmapGroup = { top: string; items: RoadmapItem[] };
export type Roadmap = Record<RoadmapSection, RoadmapGroup[]>;

/** The first segment of a path ("/read/x" → "/read"); a slug walks its parents; else "/". */
export function topOf(id: string, parents: ReadonlyMap<string, string | undefined>): string {
  let x: string | undefined = id;
  for (let i = 0; x !== undefined && i < 64; i++) {
    if (isPathId(x)) return `/${x.split("/")[1]}`;
    x = parents.get(x);
  }
  return "/";
}

const sectionOf = (e: ProgressEntry, refs: ReadonlySet<string>): RoadmapSection =>
  e.status === "done"
    ? "done"
    : waitsOnOwner(e, refs)
      ? "waiting"
      : e.status === "doing"
        ? "doing"
        : "queued";

/** Nodes the board lists: tasks and the like, not groups, people or the owner's to-dos. */
const listed = (e: { id: string; kind?: string }) =>
  e.kind !== "group" && e.kind !== "person" && !isOwnerTodo(e.id);

/**
 * Open live nodes by status; done ones from the history plus the live tree's
 * done nodes (newer). A node open now is not listed as done, even if it was.
 */
export function roadmapSections(
  rows: readonly ProgressEntry[],
  history: readonly ProgressHistory[],
): Roadmap {
  const parents = new Map<string, string | undefined>();
  for (const h of history) parents.set(h.id, h.parent);
  for (const e of rows) parents.set(e.id, e.parent);
  const refs = openTodoRefs(rows);
  const out = Object.fromEntries(ROADMAP_SECTIONS.map((s) => [s, new Map()])) as Record<
    RoadmapSection,
    Map<string, RoadmapItem[]>
  >;
  const add = (section: RoadmapSection, id: string, item: RoadmapItem) => {
    const top = topOf(id, parents);
    const list = out[section].get(top) ?? [];
    list.push(item);
    out[section].set(top, list);
  };
  const done = new Map<string, ProgressHistory>();
  for (const h of history) if (listed(h)) done.set(h.id, h);
  for (const e of rows) {
    if (!listed(e)) continue;
    if (e.status === "done") {
      done.set(e.id, progressHistory(e));
      continue;
    }
    done.delete(e.id);
    const item: RoadmapItem = { id: e.id, title: e.task, prs: prsOf(e), at: e.at };
    if (e.link) item.link = e.link;
    if (e.etaAt !== undefined) item.etaAt = e.etaAt;
    if (e.needs) item.needs = e.needs;
    add(sectionOf(e, refs), e.id, item);
  }
  for (const h of done.values()) {
    const item: RoadmapItem = { id: h.id, title: h.title, prs: h.prs ?? [], at: h.endedAt };
    if (h.link) item.link = h.link;
    add("done", h.id, item);
  }
  // Within a group: soonest ETA first when open (then newest), newest first when done.
  const order = (a: RoadmapItem, b: RoadmapItem) =>
    (a.etaAt ?? Infinity) - (b.etaAt ?? Infinity) || b.at - a.at;
  return Object.fromEntries(
    ROADMAP_SECTIONS.map((s) => [
      s,
      [...out[s]]
        .map(([top, items]) => ({ top, items: items.sort(order) }))
        // Groups: the one with the newest item first.
        .sort(
          (a, b) => Math.max(...b.items.map((i) => i.at)) - Math.max(...a.items.map((i) => i.at)),
        ),
    ]),
  ) as Roadmap;
}

/** How many items a section holds. */
export const sectionCount = (groups: readonly RoadmapGroup[]) =>
  groups.reduce((n, g) => n + g.items.length, 0);

export type RoadmapState = {
  rows: ProgressEntry[];
  history: ProgressHistory[];
  /** The socket is open and has sent the tree. */
  live: boolean;
  /** The history has come. */
  loaded: boolean;
};

export type RoadmapDeps = {
  url: string;
  socket?: (url: string) => Sock;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (t: unknown) => void;
  onWake?: (fn: () => void) => () => void;
};

/** How many done records the page asks for (the hub sends at most 2000). */
export const ROADMAP_HISTORY_LIMIT = 2000;

/**
 * The owner's progress socket for the board: on open it asks for the done
 * history; the snapshot and events keep the open nodes current, and a node
 * going done joins the history. Reconnects as the tree does (1 s doubling to
 * 60 s, GIVE_UP failures, then a wake). Returns the unsubscribe.
 */
export function roadmapSource(deps: RoadmapDeps, onUpdate: (s: RoadmapState) => void): () => void {
  const open = deps.socket ?? ((u: string) => new WebSocket(u) as unknown as Sock);
  const later = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = deps.clearTimeout ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const wake = deps.onWake ?? browserWake;
  let view: ProgressView = { rows: [], log: [] };
  let history: ProgressHistory[] = [];
  let live = false;
  let loaded = false;
  let ws: Sock | null = null;
  let retry: unknown;
  let failures = 0;
  let stopped = false;
  const push = () => {
    if (!stopped) onUpdate({ rows: view.rows, history, live, loaded });
  };
  const connect = () => {
    if (retry !== undefined) cancel(retry);
    retry = undefined;
    if (stopped || ws) return;
    const sock = open(deps.url);
    ws = sock;
    sock.onopen = () => {
      failures = 0;
      try {
        sock.send?.(JSON.stringify({ type: "history", limit: ROADMAP_HISTORY_LIMIT }));
      } catch {}
    };
    sock.onmessage = (ev) => {
      const h = parseHistoryMessage(ev.data);
      if (h) {
        history = h.items;
        loaded = true;
        return push();
      }
      const msg = parseProgressMessage(ev.data);
      if (!msg) return;
      view = applyProgressMessage(view, msg);
      if (msg.type === "progress" && msg.status === "done" && listed(msg))
        history = [progressHistory(msg), ...history.filter((x) => x.id !== msg.id)];
      live = true;
      push();
    };
    const lost = () => {
      if (ws !== sock) return;
      ws = null;
      if (live) {
        live = false;
        push();
      }
      if (stopped || ++failures > GIVE_UP) return;
      retry = later(connect, Math.min(MAX_DELAY, 1000 * 2 ** (failures - 1)));
    };
    sock.onclose = lost;
    sock.onerror = () => {
      lost();
      sock.close();
    };
  };
  const off = wake(() => {
    if (ws) return;
    failures = 0;
    connect();
  });
  connect();
  return () => {
    stopped = true;
    if (retry !== undefined) cancel(retry);
    off();
    ws?.close();
  };
}
