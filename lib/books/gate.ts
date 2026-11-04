// Who gets /books: the `books.catalogue` flag, or the owner while it is off
// (docs/feature-flags.md). D1 only: the import keys the user's book by
// read_materials.source_key, which only D1 has. Not tied to reader v2: an
// imported book opens in whichever reader the user has.

import { flagIn, type FlagValues } from "@/lib/flags";

export function booksOn(flags: FlagValues | null | undefined, owner: boolean): boolean {
  return flagIn(flags, "books.catalogue") || owner;
}
