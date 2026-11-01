/**
 * The state tree's nav ids and its kept place, pure (no React): navIndexOf
 * (TreeNode → NavIndex by index paths) and keepTree / restoreTree, which
 * carry the focus and opened nodes across a refresh by title paths
 * (ui-store.ts).
 */
import type { TreeNode } from "./state-tree";
import { type NavIndex, type TreeNavState, indexTree, restoreNav } from "./tree-nav";

/** Ids are index paths ("0", "0.2", "0.2.1"), so a reload keeps the focus. */
export function navIndexOf(root: TreeNode | null): {
  ix: NavIndex;
  byId: Map<string, TreeNode>;
} {
  const byId = new Map<string, TreeNode>();
  const ix = indexTree(
    root?.children ?? [],
    (n) => n.children,
    (n, parent, i) => {
      const id = parent === null ? String(i) : `${parent}.${i}`;
      byId.set(id, n);
      return id;
    },
  );
  return { ix, byId };
}

/**
 * The tree's place as kept across a refresh (ui-store.ts): by title paths,
 * not index ids, so a node added above it (state-tree.md edited, a live
 * progress node) does not move the focus onto a neighbour.
 */
export type KeptTree = {
  /** The focused node's titles, root to node. */
  focus: string[] | null;
  /** Each opened node's titles and depth. */
  expanded: [string[], number][];
  /** The minimized tree body's scrollTop. */
  scroll: number;
};

const titlesOf = (byId: Map<string, TreeNode>, id: string): string[] => {
  const parts = id.split(".");
  return parts.map((_, i) => byId.get(parts.slice(0, i + 1).join("."))?.title ?? "");
};

/** The nav state as title paths. */
export function keepTree(
  byId: Map<string, TreeNode>,
  nav: Pick<TreeNavState, "focusId" | "expanded">,
  scroll: number,
): KeptTree {
  return {
    focus: nav.focusId === null ? null : titlesOf(byId, nav.focusId),
    expanded: Object.entries(nav.expanded).map(([id, d]) => [titlesOf(byId, id), d]),
    scroll: Math.max(0, Math.round(scroll)),
  };
}

/** The deepest node along a title path, and how many titles matched. */
function walkTitles(ix: NavIndex, byId: Map<string, TreeNode>, path: string[]) {
  let id: string | null = null;
  let depth = 0;
  for (const title of path) {
    const kids: string[] = id === null ? ix.roots : (ix.children.get(id) ?? []);
    const hit = kids.find((k) => byId.get(k)?.title === title);
    if (!hit) break;
    id = hit;
    depth++;
  }
  return { id, depth };
}

/**
 * The kept place on the tree as it is now. The focus falls back to its
 * nearest ancestor still there (a done task dropped from the plan focuses
 * the plan); opened nodes that are gone are dropped (restoreNav prunes and
 * caps the rest). Null when not even its top-level node is left.
 */
export function restoreTree(
  ix: NavIndex,
  byId: Map<string, TreeNode>,
  kept: Pick<KeptTree, "focus" | "expanded"> | null,
): TreeNavState | null {
  if (!kept?.focus?.length) return null;
  const focusId = walkTitles(ix, byId, kept.focus).id;
  if (focusId === null) return null;
  const expanded: Record<string, number> = {};
  for (const [path, d] of kept.expanded) {
    const w = walkTitles(ix, byId, path);
    if (w.id !== null && w.depth === path.length) expanded[w.id] = d;
  }
  return restoreNav(ix, { focusId, expanded });
}
