/**
 * The minimized chat's frontier lines (`DebugChatProps.frontier`): the last
 * thing done, what is in progress, and what comes next. The data is computed
 * elsewhere (the host's state tree); this file only has the shapes and the
 * small display rules, so they can be tested without a DOM.
 */

/** Who is on an item: an agent (with an opaque id slug) or a human. */
export type Assignee = { type: "agent" | "human"; name: string; id?: string };
export type FrontierItem = { title: string; path?: string; assignee?: Assignee };
/**
 * One status line. With `count` > 1, `text` sums up a group (e.g. an idiom
 * such as 多线并进) and `items` lists its members.
 */
export type FrontierLine = {
  text: string;
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
