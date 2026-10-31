"use client";

import { useMemo } from "react";
import { type TreeNode, type TreeStatus, countOpen } from "./state-tree";
import { BLINK, uiStrings } from "./ui-strings";
import { type NavIndex, type TreeNavEvent, type TreeNavState, isVisible } from "./tree-nav";

/**
 * The state tree as the chat shows it, driven by treeNav (tree-nav.ts): the
 * top-level nodes as a row of chips (title, status glyph, 〔open count〕; the
 * row scrolls sideways), and the one open branch below it as lines, each
 * level indented, as deep as its detents opened it. Box-less, like the log:
 * text with the halo, an underline on the focused one. Tapping a chip or a
 * line focuses it and opens it a level.
 */

export { navIndexOf } from "./tree-keep";

const GLYPH: Record<TreeStatus, string> = { open: "○", doing: "◐", blocked: "!", done: "✓" };
const INK: Record<TreeStatus, string> = {
  open: "oklch(0.62 0.03 260)",
  doing: "oklch(0.6 0.16 250)",
  blocked: "oklch(0.7 0.16 70)",
  done: "oklch(0.62 0.15 150)",
};
const ACCENT = "oklch(0.58 0.21 33)";

function Label({ node, hidden }: { node: TreeNode; hidden: boolean }) {
  const open = hidden ? countOpen(node).open : 0;
  return (
    <>
      {node.status && (
        <span
          aria-hidden
          className={`me-0.5 inline-block ${node.status === "doing" ? BLINK : ""}`}
          style={{ color: INK[node.status] }}
        >
          {GLYPH[node.status]}
        </span>
      )}
      <span className={node.status === "done" ? "opacity-60" : ""}>{node.title || "—"}</span>
      {node.needsOwner && node.status !== "done" && (
        <span aria-label="needs you" className="ms-0.5 font-bold" style={{ color: ACCENT }}>
          (!)
        </span>
      )}
      {open > 0 && <span className="ms-0.5 tabular-nums opacity-60">〔{open}〕</span>}
    </>
  );
}

export function TreeChips({
  root,
  nav,
  ix,
  byId,
  onNav,
  status,
  empty,
}: {
  root: TreeNode | null;
  nav: TreeNavState;
  ix: NavIndex;
  byId: Map<string, TreeNode>;
  onNav: (ev: TreeNavEvent) => void;
  /** Shown instead (loading, or why it failed). */
  status?: string;
  /** "The tree is empty.", localized by the host. */
  empty?: string;
}) {
  /** The open branch's top chip: the one the accordion has open (or the focus's). */
  const openTop = useMemo(() => {
    const ids = Object.keys(nav.expanded);
    return ids.length ? ids[0]!.split(".")[0]! : null;
  }, [nav.expanded]);
  if (status) return <p data-testid="tree-chips-status" className="m-0 opacity-60">{status}</p>;
  if (!root || !ix.roots.length)
    return (
      <p data-testid="tree-chips-status" className="m-0 opacity-60">
        {empty ?? "The tree is empty."}
      </p>
    );
  /** The open branch's lines, in order: every visible descendant of openTop. */
  const lines: { id: string; level: number }[] = [];
  const walk = (id: string, level: number) => {
    for (const c of ix.children.get(id) ?? []) {
      if (!isVisible(ix, nav, c)) continue;
      lines.push({ id: c, level });
      walk(c, level + 1);
    }
  };
  if (openTop) walk(openTop, 0);
  const focus = nav.focusId;
  const mark = (id: string) =>
    id === focus ? "underline decoration-2 underline-offset-[3px]" : "";
  return (
    <div data-testid="tree-chips" className="min-w-0 max-w-full space-y-0.5 leading-snug">
      {/* The top-level chips: a row that scrolls sideways. */}
      <div
        role="tablist"
        aria-label={uiStrings().stateTree}
        data-testid="tree-chip-row"
        className="pointer-events-auto flex gap-x-3 overflow-x-auto overflow-y-hidden overscroll-x-contain whitespace-nowrap [scrollbar-width:none]"
      >
        {ix.roots.map((id) => {
          const node = byId.get(id)!;
          const opened = id === openTop;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={opened}
              data-testid="tree-chip"
              data-id={id}
              data-focus={id === focus || undefined}
              data-open={opened || undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onNav({ type: "tapChip", id })}
              className={`tap-40 shrink-0 border-0 bg-transparent p-0 text-start text-inherit ${opened ? "font-semibold" : ""} ${mark(id)}`}
            >
              <Label node={node} hidden={!opened} />
            </button>
          );
        })}
      </div>
      {lines.length > 0 && (
        <ul data-testid="tree-lines" className="m-0 list-none space-y-0.5 p-0">
          {lines.map(({ id, level }) => {
            const node = byId.get(id)!;
            const kids = ix.children.get(id) ?? [];
            const shut = kids.length > 0 && !kids.some((k) => isVisible(ix, nav, k));
            return (
              <li
                key={id}
                data-testid="tree-line"
                data-id={id}
                data-level={level}
                data-focus={id === focus || undefined}
                style={{ paddingInlineStart: `${level * 0.75}rem` }}
              >
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onNav({ type: "tapChip", id })}
                  className={`pointer-events-auto border-0 bg-transparent p-0 text-start text-inherit ${mark(id)}`}
                >
                  {kids.length > 0 && (
                    <span aria-hidden className="me-0.5 opacity-60">
                      {shut ? "▸" : "▾"}
                    </span>
                  )}
                  <Label node={node} hidden={shut} />
                </button>
                {node.note && !shut && level < 1 && (
                  <p className="m-0 ps-3 text-[10px] opacity-60">{node.note}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
