// Who gets /library (the catalogue) and /books (My books): two positive flags,
// both on by default for everyone (owner, 2026-11-10: never owner-only).
// Holders of the `dev` permission (a per-account grant) keep both while a flag
// is off, to check a fix before turning it back on. D1 only: the shelf keys a
// user's book by read_materials.source_key, which only D1 has. Not tied to a
// reader: a book opens in whichever reader the user has.
//
// `library.catalogue` replaced `books.catalogue` (docs/books-plan.md, "/library
// and /books").

import { flagIn, type FlagValues } from "@/lib/flags";

/** /library and the catalogue APIs (/api/books/import, resolve, search). */
export function libraryOn(flags: FlagValues | null | undefined, dev: boolean): boolean {
  return flagIn(flags, "library.catalogue") || dev;
}

/** /books, the user's own shelf. */
export function booksMineOn(flags: FlagValues | null | undefined, dev: boolean): boolean {
  return flagIn(flags, "books.mine") || dev;
}
