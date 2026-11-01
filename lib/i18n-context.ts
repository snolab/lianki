/**
 * Translation context for intlayer content declarations (docs/i18n.md).
 *
 * A short string sent to translation on its own loses its meaning: "Undo",
 * "New swipe" or "Experimental" can each be read several ways. Every key of a
 * dictionary therefore carries a line saying where it appears, what it is
 * for, and how it is used. intlayer 8 has no per-key metadata, only the
 * dictionary's `description`, which `intlayer fill` hands to the translating
 * model as context — so the per-key lines live there, one per key, and the
 * TypeScript type requires a line for every key of `content`.
 */

/**
 * Context lines for a nested `content`: the same shape, one string per
 * translation (`t(...)`) leaf, so a leaf without a line is a type error.
 */
export type KeyContext<C> = {
  [K in keyof C]: C[K] extends { nodeType: unknown } ? string : KeyContext<C[K]>;
};

/** Nested context lines → `group.key` entries for `describeKeys`. */
export function flattenContext(context: object, prefix = ""): Record<string, string> {
  return Object.fromEntries(
    Object.entries(context).flatMap(([k, v]) =>
      typeof v === "string"
        ? [[prefix + k, v]]
        : Object.entries(flattenContext(v as object, `${prefix}${k}.`)),
    ),
  );
}

const HEADER = "Context per key (where it appears · what it is for · how it is used):";

/** The dictionary `description`: its purpose, then one `- key: context` line per key. */
export function describeKeys<K extends string>(about: string, keys: Record<K, string>): string {
  const lines = Object.entries<string>(keys).map(([k, v]) => `- ${k}: ${v.replace(/\s+/g, " ")}`);
  return [about.trim(), "", HEADER, ...lines].join("\n");
}

/** The per-key context back out of a description written by `describeKeys`. */
export function keyContext(description: string | undefined): Record<string, string> {
  const at = description?.indexOf(HEADER) ?? -1;
  if (at < 0) return {};
  const out: Record<string, string> = {};
  for (const line of description!.slice(at + HEADER.length).split("\n")) {
    const m = line.match(/^- ([\w.]+): (.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}
