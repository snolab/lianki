/**
 * A line diff for the /dev/templates version list: which lines of a version
 * the editor removed, kept or added. Longest common subsequence over lines —
 * templates are short (a few hundred lines at most), so O(n·m) is fine;
 * past DIFF_MAX_CELLS it gives up and shows everything as replaced.
 */
export type DiffLine = { op: "=" | "-" | "+"; line: string };

export const DIFF_MAX_CELLS = 4_000_000;

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > DIFF_MAX_CELLS)
    return [
      ...a.map((line) => ({ op: "-" as const, line })),
      ...b.map((line) => ({ op: "+" as const, line })),
    ];
  // lcs[i][j]: the LCS length of a[i..] and b[j..]
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: "=", line: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ op: "-", line: a[i++] });
    else out.push({ op: "+", line: b[j++] });
  }
  while (i < a.length) out.push({ op: "-", line: a[i++] });
  while (j < b.length) out.push({ op: "+", line: b[j++] });
  return out;
}

/** HTML on one line is unreadable as a diff: a line break after each closing tag and <br>. */
export const htmlLines = (html: string) => html.replace(/(<\/[a-zA-Z0-9]+>|<br\s*\/?>)/g, "$1\n");
