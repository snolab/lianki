// The /books table of contents (docs/books-plan.md, "Table of contents"):
// one entry per language group on the page (its levels as sub-items), then
// 「找更多书」 and its library guide. Anchor ids are stable and built from the
// language code, so a shared link (/books#books-fr) keeps working. Client-safe.

import type { CatalogueBook } from "./catalogue";

export const FIND_SECTION_ID = "books-find-more";
export const LIBRARIES_SECTION_ID = "books-find-more-libraries";

/** A language group's anchor: from its code ("fr" → books-fr). */
export const langSectionId = (lang: string) =>
  `books-${lang.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

/** The anchor of a level within a language group ("A2–B1" → books-fr-a2-b1). */
export const levelAnchorId = (lang: string, level: string) =>
  `${langSectionId(lang)}-${level
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;

export interface TocItem {
  id: string;
  label: string;
  children?: TocItem[];
}

/**
 * Where each level of a group starts: book index → its level's anchor, on the
 * first book of that level (books arrive easiest first). Books without a
 * level hint (shared entries) get none.
 */
export function levelAnchors(lang: string, books: CatalogueBook[]): Map<number, string> {
  const out = new Map<number, string>();
  const seen = new Set<string>();
  books.forEach((b, i) => {
    if (!b.level || seen.has(b.level)) return;
    seen.add(b.level);
    out.set(i, levelAnchorId(lang, b.level));
  });
  return out;
}

/**
 * The table of contents for the groups shown (after the filter: an empty
 * group is not shown, so it has no entry). Levels are sub-items when a group
 * has two or more. `find` adds the 找更多书 section and its library guide.
 */
export function booksToc(
  groups: [lang: string, name: string, books: CatalogueBook[]][],
  find: { title: string; libraries: string } | null,
): TocItem[] {
  const items: TocItem[] = groups
    .filter(([, , books]) => books.length)
    .map(([lang, name, books]) => {
      const anchors = [...levelAnchors(lang, books)];
      return {
        id: langSectionId(lang),
        label: name,
        ...(anchors.length >= 2
          ? { children: anchors.map(([i, id]) => ({ id, label: books[i].level })) }
          : {}),
      };
    });
  if (find)
    items.push({
      id: FIND_SECTION_ID,
      label: find.title,
      children: [{ id: LIBRARIES_SECTION_ID, label: find.libraries }],
    });
  return items;
}
