/**
 * The text of each row on /dev/stt-access, kept out of the component so the
 * unit suite can check it (unit/stt-access-lines.test.ts).
 *
 * A `useIntlayer` leaf is a React element with its text on `.value`, not a
 * string: `String(leaf)` or `${leaf}` gives "[object Object]". Every leaf that
 * ends up inside a string goes through `txt` first.
 */

/** An intlayer leaf (or a plain string) as its text. */
export const txt = (leaf: unknown): string =>
  typeof leaf === "string"
    ? leaf
    : leaf && typeof leaf === "object" && typeof (leaf as { value?: unknown }).value === "string"
      ? (leaf as { value: string }).value
      : "";

/** `{name}` placeholders filled from `vars`; unknown ones are left as they are. */
export const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

/** An allowed account as its display name, or its id when it has none. Never its email. */
export const accountLabel = (a: { userId: string; name?: unknown }): string =>
  typeof a.name === "string" && a.name.trim() ? a.name.trim() : a.userId;

/** A speech server's second line: how many sessions at once, whose server, when added. */
export function workerMeta(
  w: { capacity: number | null; ownerUserId: string | null },
  c: { capacity: unknown; capacityDefault: unknown; personal: unknown },
  added: string,
): string {
  const parts = [fill(txt(c.capacity), { n: w.capacity ?? txt(c.capacityDefault) })];
  if (w.ownerUserId) parts.push(`${txt(c.personal)} (${w.ownerUserId})`);
  parts.push(added);
  return parts.join(" · ");
}
