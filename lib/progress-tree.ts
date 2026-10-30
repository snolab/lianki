/**
 * The state tree, live (docs/state-tree.md, "Live progress"): the
 * hand-edited outline stays the base, and the hub's nodes
 * (workers/push/src/progress.ts) are laid over it by path. A live node for
 * `/words/prefetch` updates the outline's `## /words` › `prefetch` item — its
 * status, owner flag, assignee, action and links, with pct, ETA and the
 * latest note in its note — or adds it there when the outline has none.
 *
 * liveTreeSource is the TreeSource the owner's views use: the base once,
 * then the overlay again on every message of the owner-only progress
 * WebSocket. Nothing polls: a close or an error schedules one reconnect with
 * backoff, and after GIVE_UP failures in a row it waits for the network or
 * the tab to come back. Without the hub (not deployed, not the owner, no
 * secret) the outline shows as it is.
 */
import type { TreeSource } from "@lianki/debug-chat/StateTree";
import {
  type TreeNode,
  type TreeStatus,
  findLinks,
  parseTreeDoc,
} from "@lianki/debug-chat/state-tree";
import {
  type ProgressEntry,
  type ProgressStatus,
  type ProgressView,
  applyProgressMessage,
  isPathId,
  openTodoRefs,
  parseProgressMessage,
  waitsOnOwner,
} from "./progress";

const STATUS: Record<ProgressStatus, TreeStatus> = {
  doing: "doing",
  review: "doing",
  blocked: "blocked",
  waiting: "open",
  "waiting-owner": "open",
  done: "done",
};

/** How an outline title answers to a path segment: its first word, or the whole title, as a slug. */
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9@/_]+/g, "-")
    .replace(/^-+|-+$/g, "");
const bare = (s: string) => s.replace(/^\//, "");
const matches = (title: string, seg: string) => {
  const first = title.trim().split(/\s+/)[0] ?? "";
  return bare(slug(first)) === seg || bare(slug(title)) === seg;
};

/** The live part of a node's note: "40% · ETA 15m · <latest note>". */
function liveNote(e: ProgressEntry) {
  const parts = [
    e.pct != null ? `${e.pct}%` : "",
    e.eta ? `ETA ${e.eta}` : "",
    e.needs ? `needs: ${e.needs}` : "",
    e.notes?.at(-1)?.text ?? "",
  ].filter(Boolean);
  return parts.join(" · ");
}

function apply(n: TreeNode, e: ProgressEntry, waiting: boolean, repo?: string) {
  n.status = STATUS[e.status];
  n.done = e.status === "done";
  if (waiting) n.needsOwner = true;
  else delete n.needsOwner;
  n.assignee = { type: e.assignee.type, name: e.assignee.name };
  if (e.action) n.action = e.action;
  const live = liveNote(e);
  if (live) n.note = n.note ? `${live}\n${n.note}` : live;
  const extra = [
    ...(e.pr ? findLinks(`#${e.pr}`, { repo }) : []),
    ...(e.link ? [{ text: e.link, url: e.link }] : []),
    ...(e.action ? findLinks(e.action, { repo }) : []),
  ];
  for (const l of extra) if (!n.links.some((x) => x.url === l.url)) n.links.push(l);
}

const clone = (n: TreeNode): TreeNode => ({
  ...n,
  links: [...n.links],
  children: n.children.map(clone),
});

/**
 * Lay the hub's nodes over the outline. Path ids walk the outline segment by
 * segment ("/words" is the heading whose first word is /words; deeper
 * segments match an item's first word or its whole title as a slug), adding
 * what is missing; a slug id with no path goes under a "Live" heading. The
 * input is not changed.
 */
export function overlayProgress(
  base: TreeNode,
  entries: ProgressEntry[],
  opts: { repo?: string } = {},
): TreeNode {
  const root = clone(base);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const refs = openTodoRefs(entries);
  const place = (segs: string[], at: TreeNode, title: (i: number) => string) => {
    let n = at;
    segs.forEach((seg, i) => {
      let hit = n.children.find((c) => matches(c.title, seg));
      if (!hit) {
        hit = { title: title(i), links: [], children: [] };
        n.children.push(hit);
      }
      n = hit;
    });
    return n;
  };
  /** A new node's title: the hub's task for it, else the segment ("/words" at the top). */
  const titleOf = (segs: string[], i: number) => {
    const e = byId.get(`/${segs.slice(0, i + 1).join("/")}`);
    if (e && e.kind !== "person" && e.kind !== "group") return e.task;
    return i === 0 && !segs[0]!.startsWith("@") ? `/${segs[0]}` : segs[i]!;
  };
  // Parents first, so a child lands under its (possibly new) parent.
  const ordered = [...entries].sort((a, b) => a.id.split("/").length - b.id.split("/").length);
  for (const e of ordered) {
    if (e.kind === "group" || e.kind === "person") continue;
    let target: TreeNode;
    if (isPathId(e.id)) {
      const segs = e.id.slice(1).split("/");
      target = place(segs, root, (i) => titleOf(segs, i));
    } else {
      const live = place(["live"], root, () => "Live");
      target = live.children.find((c) => c.title === e.task) ?? place([e.id], live, () => e.task);
    }
    apply(target, e, waitsOnOwner(e, refs), opts.repo);
  }
  return root;
}

type Sock = {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(): void;
};
export type LiveDeps = {
  /** The base outline (markdown). */
  base: () => string | Promise<string>;
  /** The hub's WebSocket URL. */
  url: string;
  repo?: string;
  socket?: (url: string) => Sock;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (t: unknown) => void;
  /** Called with a function to run when the network or the tab comes back; returns its remover. */
  onWake?: (fn: () => void) => () => void;
};

/** Reconnect delays: 1 s doubling to 60 s; after GIVE_UP failures in a row, wait for a wake. */
export const MAX_DELAY = 60_000;
export const GIVE_UP = 10;

/** The progress WebSocket on this page's host. */
export const progressSocketUrl = (loc: { protocol: string; host: string }) =>
  `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}/api/version/progress`;

export const browserWake = (fn: () => void) => {
  const vis = () => document.visibilityState === "visible" && fn();
  window.addEventListener("online", fn);
  document.addEventListener("visibilitychange", vis);
  return () => {
    window.removeEventListener("online", fn);
    document.removeEventListener("visibilitychange", vis);
  };
};

/** The outline with live progress laid over it, pushed on every hub message. */
export function liveTreeSource(deps: LiveDeps): TreeSource {
  const open = deps.socket ?? ((u: string) => new WebSocket(u) as unknown as Sock);
  const later = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = deps.clearTimeout ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const wake = deps.onWake ?? browserWake;
  return {
    subscribe(onUpdate, onError) {
      let base: TreeNode | null = null;
      let view: ProgressView = { rows: [], log: [] };
      let live = false;
      let ws: Sock | null = null;
      let retry: unknown;
      let failures = 0;
      let stopped = false;
      const push = () => {
        if (stopped || !base) return;
        onUpdate(overlayProgress(base, view.rows, { repo: deps.repo }).children, { live });
      };
      Promise.resolve()
        .then(deps.base)
        .then(
          (md) => {
            base = parseTreeDoc(md, { repo: deps.repo });
            push();
          },
          (e) => !stopped && onError?.(e),
        );
      const connect = () => {
        if (retry !== undefined) cancel(retry);
        retry = undefined;
        if (stopped || ws) return;
        const sock = open(deps.url);
        ws = sock;
        sock.onopen = () => {
          failures = 0;
        };
        sock.onmessage = (ev) => {
          const msg = parseProgressMessage(ev.data);
          if (!msg) return;
          view = applyProgressMessage(view, msg);
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
    },
  };
}
