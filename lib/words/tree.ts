/**
 * Word-list tree (Anki-style decks and subdecks) — pure helpers for the
 * picker's drag-to-nest and for "study this group".
 *
 * Lists arrive flat, in saved order, each with a parentId. The picker shows
 * them depth-first; dragging moves a row (with its subtree) and its horizontal
 * offset picks the depth, as in dnd-kit's sortable-tree pattern.
 */

export type TreeNode = { id: string; parentId: string | null };
export type FlatItem<T extends TreeNode> = T & { depth: number };

/** Depth-first order with depths. Orphans (missing parent) sit at the top level. */
export function flatten<T extends TreeNode>(nodes: T[]): FlatItem<T>[] {
  const ids = new Set(nodes.map((n) => n.id));
  const kids = new Map<string | null, T[]>();
  for (const n of nodes) {
    const p = n.parentId && ids.has(n.parentId) && n.parentId !== n.id ? n.parentId : null;
    kids.set(p, [...(kids.get(p) ?? []), n]);
  }
  const out: FlatItem<T>[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const n of kids.get(parent) ?? []) {
      if (seen.has(n.id)) continue; // a cycle in stored data: show each once
      seen.add(n.id);
      out.push({ ...n, depth });
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  // Anything only reachable through a cycle still gets a row.
  for (const n of nodes) if (!seen.has(n.id)) out.push({ ...n, depth: 0 });
  return out;
}

/** Ids of everything below `id` in a flattened tree. */
export function descendants<T extends TreeNode>(flat: FlatItem<T>[], id: string): string[] {
  const i = flat.findIndex((x) => x.id === id);
  if (i < 0) return [];
  const out: string[] = [];
  for (let j = i + 1; j < flat.length && flat[j].depth > flat[i].depth; j++) out.push(flat[j].id);
  return out;
}

/** Rows to show: children of collapsed rows are hidden. */
export function visible<T extends TreeNode>(flat: FlatItem<T>[], collapsed: Set<string>) {
  const hidden = new Set(
    flat.filter((x) => collapsed.has(x.id)).flatMap((x) => descendants(flat, x.id)),
  );
  return flat.filter((x) => !hidden.has(x.id));
}

/**
 * Where a dragged row would land: its depth from the horizontal offset, clamped
 * so it can only nest under the row above it, and its resulting parent.
 */
export function projectDrop<T extends TreeNode>(
  items: FlatItem<T>[],
  activeId: string,
  overId: string,
  offsetX: number,
  indent: number,
): { depth: number; parentId: string | null } {
  const from = items.findIndex((x) => x.id === activeId);
  const to = items.findIndex((x) => x.id === overId);
  const moved = [...items];
  const [active] = moved.splice(from, 1);
  moved.splice(to, 0, active);
  const prev = moved[to - 1];
  const next = moved[to + 1];
  const wanted = active.depth + Math.round(offsetX / indent);
  const max = prev ? prev.depth + 1 : 0;
  const min = next ? next.depth : 0;
  const depth = Math.max(min, Math.min(max, wanted));
  if (depth === 0 || !prev) return { depth: 0, parentId: null };
  if (depth === prev.depth + 1) return { depth, parentId: prev.id };
  // Same depth as some earlier row: share that row's parent.
  const sibling = moved
    .slice(0, to)
    .reverse()
    .find((x) => x.depth === depth);
  return { depth, parentId: sibling?.parentId ?? null };
}

/**
 * The full saved order after a drop. `items` are the rows that took part in
 * the drag (the active row's subtree and collapsed subtrees left out); each
 * hidden subtree is put back right after its root, keeping its parents.
 */
export function applyDrop<T extends TreeNode>(
  flat: FlatItem<T>[],
  items: FlatItem<T>[],
  activeId: string,
  overId: string,
  parentId: string | null,
): { id: string; parentId: string | null }[] {
  const from = items.findIndex((x) => x.id === activeId);
  const to = items.findIndex((x) => x.id === overId);
  const moved = [...items];
  const [active] = moved.splice(from, 1);
  moved.splice(to, 0, { ...active, parentId });
  const shown = new Set(items.map((x) => x.id));
  const out: { id: string; parentId: string | null }[] = [];
  for (const row of moved) {
    out.push({ id: row.id, parentId: row.parentId });
    for (const id of descendants(flat, row.id))
      if (!shown.has(id) && !out.some((o) => o.id === id))
        out.push({ id, parentId: flat.find((x) => x.id === id)!.parentId });
  }
  return out;
}
