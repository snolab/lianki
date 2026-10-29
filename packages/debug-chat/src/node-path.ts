/**
 * State-tree node paths in the debug chat (docs/dev-debug-widget.md, "Node
 * paths"). Messages are addressed to state-tree nodes ("/words/prefetch");
 * a node's assignee (an agent or a human) receives them. The pure rules,
 * shared by the hub, the sender CLI and the widget. No imports, so the push
 * Worker can bundle it.
 */

/** Longest node path kept, in characters ("/words/prefetch"). */
export const MAX_NODE_PATH = 80;
/** Longest assignee id kept (`agentId`), in characters. */
export const MAX_AGENT_ID = 40;
/** The main thread's node: the root of the tree. */
export const ROOT_NODE = "/";

/** One path segment: URL-safe characters only. */
const SEG = /^[A-Za-z0-9._~-]+$/;

/**
 * A node path, normalised: trimmed, a leading "/", segments split on "/" or
 * "›" (so "/words › prefetch" and "words/prefetch" are "/words/prefetch"),
 * no empty, "." or ".." segment, at most MAX_NODE_PATH characters, path
 * characters only. Anything else is undefined (never truncated: a cut path
 * would name another node).
 */
export function nodePath(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (!s || s.length > MAX_NODE_PATH * 2) return undefined;
  const segs = s.split(/\s*[/›]\s*/).filter(Boolean);
  if (segs.some((x) => !SEG.test(x) || x === "." || x === "..")) return undefined;
  const out = `/${segs.join("/")}`;
  return out.length <= MAX_NODE_PATH ? out : undefined;
}

/** An assignee id: trimmed, cut to MAX_AGENT_ID, letters, digits and ._@:+- or spaces only. */
export function agentIdOf(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim().slice(0, MAX_AGENT_ID).trim();
  return /^[\w.@:+ -]+$/.test(s) ? s : undefined;
}

/** `p` is `root` or below it. Both are normalised node paths. */
export function isWithin(p: string, root: string): boolean {
  return root === ROOT_NODE || p === root || p.startsWith(`${root}/`);
}

/** The deepest node both paths are within. */
export function commonAncestor(a: string, b: string): string {
  const x = a.split("/").filter(Boolean);
  const y = b.split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < Math.min(x.length, y.length) && x[i] === y[i]; i++) out.push(x[i]);
  return `/${out.join("/")}`;
}

/** How a node path reads in the chat: "/words › prefetch" ("/" stays "/"). */
export function pathLabel(p: string): string {
  const segs = p.split("/").filter(Boolean);
  return segs.length ? `/${segs.join(" › ")}` : ROOT_NODE;
}

/**
 * Whether a listener at node `listener` gets a message addressed to `to`
 * (both absent = the root, the main thread, as before node paths):
 * "direct" when it is that node, "observed" when it is an ancestor (the
 * root observes everything), null otherwise (a sibling or a descendant).
 */
export function routeTo(
  listener: string | undefined,
  to: string | undefined,
): "direct" | "observed" | null {
  const l = listener ?? ROOT_NODE;
  const p = to ?? ROOT_NODE;
  if (l === p) return "direct";
  return isWithin(p, l) ? "observed" : null;
}

/** An approval that lets senders within `from` address nodes within `to`. */
export type NodeGrant = { from: string; to: string; until: number };

/**
 * May a sender at node `from` address node `to`? Always into its own
 * subtree, always upward (its parent, any ancestor, the root), else only
 * under a live grant covering both. The error names the common ancestor,
 * whose listener (or the root's) may grant it.
 */
export function mayAddress(
  from: string,
  to: string,
  grants: readonly NodeGrant[] = [],
  now = Date.now(),
): { ok: true; via: "subtree" | "upward" | "grant" } | { ok: false; error: string } {
  if (isWithin(to, from)) return { ok: true, via: "subtree" };
  if (isWithin(from, to)) return { ok: true, via: "upward" };
  if (grants.some((g) => g.until > now && isWithin(from, g.from) && isWithin(to, g.to)))
    return { ok: true, via: "grant" };
  return { ok: false, error: `out of scope: needs a grant from ${commonAncestor(from, to)}` };
}

/** A leading "@<node path> " in a draft: the node it addresses and the text after it. */
const ADDRESS = /^@(\/?(?:[A-Za-z0-9._~-]+(?:(?:\/|\s*›\s*)[A-Za-z0-9._~-]+)*)?\/?)(?:\s+([\s\S]*))?$/;

/**
 * A draft that starts with "@/words › prefetch " (or "@/words/prefetch ")
 * addresses that node: `to` and the rest of the text. `complete` is false
 * while the address is still being typed (no space after it yet). Null when
 * the draft is not an address.
 */
export function parseAddress(
  draft: string,
): { to: string; text: string; complete: boolean } | null {
  if (!draft.startsWith("@/")) return null;
  const m = ADDRESS.exec(draft);
  if (!m) return null;
  const to = nodePath(m[1] || ROOT_NODE);
  if (!to) return null;
  // "@/words ›" is still being typed: the next segment follows.
  if (m[2] === undefined || m[2].startsWith("›")) return { to, text: "", complete: false };
  return { to, text: m[2].trim(), complete: true };
}

/** The node paths offered while typing "@/…": those starting with what is typed, shortest first. */
export function completeNode(partial: string, nodes: readonly string[]): string[] {
  const typed = partial.replace(/^@/, "").replace(/\s*›\s*/g, "/").trim().toLowerCase();
  return [...new Set(nodes)]
    .filter((n) => n !== ROOT_NODE && n.toLowerCase().startsWith(typed || "/"))
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
    .slice(0, 8);
}

/** A node's hue (0–359), from its path: the log line's left border. */
export function nodeHue(p: string): number {
  let h = 0x811c9dc5;
  const s = `node:${p}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 360;
}

/**
 * What a log line shows about nodes: the node it belongs to (an agent's
 * `taskPath`, else the owner's target `to`), the muted subtitle ("/words ›
 * prefetch", "→ /words › prefetch", or "/a › b → /c" for agent→agent), and
 * its left-border colour. Nothing for a main-thread line without a node.
 */
export function lineNode(m: {
  from: string;
  taskPath?: string;
  to?: string;
}): { node: string; subtitle: string; border: string } | null {
  const from = m.from === "agent" && m.taskPath && m.taskPath !== ROOT_NODE ? m.taskPath : "";
  const to = m.to && m.to !== ROOT_NODE ? m.to : "";
  if (!from && !to) return null;
  const subtitle = from
    ? to
      ? `${pathLabel(from)} → ${pathLabel(to)}`
      : pathLabel(from)
    : `→ ${pathLabel(to)}`;
  const node = from || to;
  return { node, subtitle, border: `oklch(0.7 0.09 ${nodeHue(node)})` };
}
