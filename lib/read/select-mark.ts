// How the reader draws its selection (app/(app)/reader/[id]/use-reader-select.ts):
// `data-sel` on the selected unit's elements, an element background, so each
// word keeps its own underline colour. One unit is drawn at a time: a tap on
// another word must leave nothing on the first (owner, 2026-11-05 03:00 JST,
// "连点两个不同词，两个都会高亮"). Not the CSS Custom Highlight API: on the iPhone
// a replaced ::highlight stayed painted on the words tapped before.

/**
 * Draws the selection: `data-sel` on exactly `els`, taken off every other
 * element under `root` that carries it (a unit drawn before, rows painted by
 * an earlier pass).
 */
export function markSelected(root: ParentNode, els: readonly Element[]): void {
  const keep = new Set(els);
  for (const e of root.querySelectorAll("[data-sel]"))
    if (!keep.has(e)) e.removeAttribute("data-sel");
  for (const e of els) if (!e.hasAttribute("data-sel")) e.setAttribute("data-sel", "");
}
