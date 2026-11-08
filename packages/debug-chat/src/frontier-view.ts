/**
 * The minimized chat's frontier lines (`DebugChatProps.frontier`): the last
 * thing done, what is in progress, and what comes next. The data is computed
 * elsewhere (the host's state tree); this file only has the shapes and the
 * small display rules, so they can be tested without a DOM.
 */

import { type TreeNode, crumbs, frontier as frontierOf } from "./state-tree";

/** Who is on an item: an agent (with an opaque id slug) or a human. */
export type Assignee = { type: "agent" | "human"; name: string; id?: string };
export type FrontierItem = { title: string; path?: string; assignee?: Assignee };
/**
 * One status line. With `count` > 1, `text` sums up a group (e.g. an idiom
 * such as 多线并进) and `items` lists its members.
 */
export type FrontierLine = {
  text: string;
  /**
   * Timed tasks (eta.ts etaParts): the line is drawn as these parts, each a
   * name that truncates and minutes that never do, the first part yielding
   * space first. `text` is the whole line (title, screen readers).
   */
  parts?: { name: string; min: string; late?: boolean }[];
  count?: number;
  items?: FrontierItem[];
  assignee?: Assignee;
};
export type Frontier = { done?: FrontierLine; doing?: FrontierLine; next?: FrontierLine };

export const FRONTIER_ROWS = [
  { key: "done", mark: "✓", label: "Last done" },
  { key: "doing", mark: "▶", label: "In progress" },
  { key: "next", mark: "›", label: "Next" },
] as const;

/** Visible characters of an agent id at the line's end. */
export const SHORT_ID_LEN = 6;
/** Longer than this, an "id" is more likely a token than a slug: hidden. */
export const MAX_ID_LEN = 64;
/** How long a touch must rest on the id to show the full one. */
export const LONG_PRESS_MS = 500;

/**
 * The agent id to show, or null. Only agents have one shown, and only an
 * opaque slug: anything that looks like a host, a path, a pid:port or a
 * token (a dot, colon or slash, or over 64 characters) is dropped.
 */
export function shownAgentId(a: Assignee | undefined): string | null {
  if (!a || a.type !== "agent" || !a.id) return null;
  const id = a.id.trim();
  if (!id || id.length > MAX_ID_LEN || /[.:/\\]/.test(id)) return null;
  return id;
}

/** The last SHORT_ID_LEN characters, for the line's end. */
export const shortId = (id: string) => id.slice(-SHORT_ID_LEN);

/** The `〔N〕` after a group's summary; nothing for a single item. */
export const countBadge = (n: number | undefined) => (n && n > 1 ? `〔${n}〕` : "");

/** The first character of a name (a whole code point), upper-cased. */
export function initialOf(name: string): string {
  const first = [...name.trim()][0] ?? "?";
  return first.toLocaleUpperCase();
}

/** A stable hue for a name (FNV-1a), for its initial's circle. */
export function hueOf(name: string): number {
  let h = 0x811c9dc5;
  for (const ch of name) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 360;
}

/** The fallback avatar's colour: the name's hue, mid lightness. */
export const avatarColor = (name: string) => `oklch(0.6 0.13 ${hueOf(name)})`;

/**
 * The minimized bar's lines from a tree (state-tree.ts frontier()), in the
 * shape the bar draws (frontier-view.ts). Only what is live: the items an
 * agent reported to the progress hub (`TreeNode.live`) that are in progress
 * or wait on the owner — one ▶ line, no ✓ done and no › next. Its text is the
 * ≈ summary in the page's language (else zh, en), or "In progress" in it,
 * never an item's title: the bundled outline's items are developer notes,
 * often finished days ago (the owner, 2026-11-03, asked what "iOS glass: first
 * card under the toolbar…" was). A tap still lists the items.
 */
export function treeFrontier(
  root: TreeNode | null,
  opts: { locale?: string; inProgress?: string } = {},
): Frontier | undefined {
  if (!root) return undefined;
  const e = frontierOf(root, { locale: opts.locale, live: true }).doing;
  if (!e) return undefined;
  return {
    doing: {
      text: e.summary ?? opts.inProgress ?? "In progress",
      count: e.count,
      assignee: e.count > 1 ? undefined : e.assignee,
      items: e.items.map((it) => ({ title: it.title, path: crumbs(it.path), assignee: it.assignee })),
    },
  };
}
