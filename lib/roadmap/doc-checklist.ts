/**
 * A doc step's checklist: the Markdown task items `- [ ]` and `- [x]` (also
 * `*`, `+`, `1.`, inside block quotes, nested at any depth). Progress =
 * checked / all; a doc without task items has no progress (n/a). Fenced code
 * is skipped, so a checklist quoted in a code block counts for nothing.
 * Pure: the page counts, toggles and renders with the same rule.
 */

/** A task item line: quote markers, indent, a bullet or number, then [ ] / [x]. */
const TASK = /^((?:\s*>)*\s*(?:[-*+]|\d{1,9}[.)])\s+\[)([ xX])(\])(?=\s|$)/;
const FENCE = /^(?:\s*>)*\s*(`{3,}|~{3,})/;

/** Each task item in document order: its line and whether it is ticked. */
export function taskItems(md: string): { line: number; checked: boolean }[] {
  const out: { line: number; checked: boolean }[] = [];
  let fence: string | null = null;
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const f = lines[i].match(FENCE);
    if (f) {
      const mark = f[1];
      if (fence === null) fence = mark;
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const m = lines[i].match(TASK);
    if (m) out.push({ line: i, checked: m[2] !== " " });
  }
  return out;
}

/** Checked and total task items; total 0 means progress n/a. */
export function countChecks(md: string): { done: number; total: number } {
  const items = taskItems(md);
  return { done: items.filter((t) => t.checked).length, total: items.length };
}

/** Progress 0..1, or null when the doc has no checklist. */
export function docProgress(md: string): number | null {
  const { done, total } = countChecks(md);
  return total === 0 ? null : done / total;
}

/**
 * The Markdown with task item `index` (document order) set to `checked`, or
 * unchanged when there is no such item. Only the one character between the
 * brackets changes, so the learner's text stays as written.
 */
export function setCheck(md: string, index: number, checked: boolean): string {
  const item = taskItems(md)[index];
  if (!item) return md;
  const lines = md.split("\n");
  lines[item.line] = lines[item.line].replace(
    TASK,
    (_m, a, _c, b) => `${a}${checked ? "x" : " "}${b}`,
  );
  return lines.join("\n");
}

/**
 * The doc's pace log after ticking (push now) or unticking (drop the latest
 * entry) an item, kept to `max` entries.
 */
export function logToggle(
  log: readonly string[] | undefined,
  checked: boolean,
  now: Date,
  max = 1000,
) {
  const next = [...(log ?? [])];
  if (checked) next.push(now.toISOString());
  else next.pop();
  return next.slice(-max);
}
