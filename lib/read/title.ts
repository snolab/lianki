/** The longest title a user can give a read material (characters). */
export const TITLE_MAX = 200;

/**
 * A title the user typed for a read material (the /read row menu's Rename):
 * whitespace collapsed and trimmed, control characters dropped, at most
 * TITLE_MAX characters (code points, so a surrogate pair is never split).
 * Null when nothing is left, or the input is not a string.
 */
export function cleanTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = [...raw]
    .map((c) => (c.charCodeAt(0) < 0x20 || c === "\u007f" ? " " : c))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return null;
  const cps = [...s];
  return cps.length > TITLE_MAX ? cps.slice(0, TITLE_MAX).join("").trimEnd() : s;
}
