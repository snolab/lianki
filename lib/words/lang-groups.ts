/**
 * Language groups on /words: a parent group per language ("Japanese") holding
 * that language's lists (JLPT N5 → N1, top 1–500 → 2501–3000, imported decks).
 * Pure helpers, shared by the picker and the server.
 */

/** Group rows keep `lang: "mul"` unless they stand for one language. */
export const MULTI_LANG = "mul";

type Named = { name: string; lang: string };

/**
 * A list's name as shown under its parent: inside a group of the same
 * language, the "Japanese · " prefix of a catalog name says nothing new, so
 * "Japanese · JLPT N5" reads "JLPT N5". The stored name is not changed.
 */
export function shownName(list: Named, parent: Named | null | undefined): string {
  if (!parent || parent.lang === MULTI_LANG || parent.lang !== list.lang) return list.name;
  const cut = list.name.indexOf(" · ");
  if (cut <= 0) return list.name;
  const rest = list.name.slice(cut + 3).trim();
  return rest || list.name;
}
