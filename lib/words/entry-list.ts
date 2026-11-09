/**
 * A list whose words are kept in D1 (word_list_entries), not in a catalog
 * file: an Anki deck imported at /words/import ("anki:<deck id>"), or a
 * book's own word list made by the reader's in-place review ("book:<hash>",
 * lib/read/book-word-list.ts), or a word list imported from a .txt/.csv file
 * at /import ("import:<job id>", lib/import/words-handler.ts).
 */
export const isEntrySource = (source: string | null | undefined): boolean =>
  !!source && ["anki:", "book:", "import:"].some((p) => source.startsWith(p));
