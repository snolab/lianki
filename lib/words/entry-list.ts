/**
 * A list whose words are kept in D1 (word_list_entries), not in a catalog
 * file: an Anki deck imported at /words/import ("anki:<deck id>"), or a
 * book's own word list made by the reader's in-place review ("book:<hash>",
 * lib/read/book-word-list.ts).
 */
export const isEntrySource = (source: string | null | undefined): boolean =>
  !!source && (source.startsWith("anki:") || source.startsWith("book:"));
