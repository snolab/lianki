// Who a book's deep link opens for (docs/books-plan.md, "Combo-click expanding
// selection"). A link names the book by its content hash (lib/read/units.ts
// bookHash: 16 hex digits), so it survives a re-import of the same text and
// works for everyone who has that text: their own upload, or the same
// catalogue book. It resolves only among the signed-in user's own materials;
// for anyone else — signed out, or without that text — it is a plain 404, the
// same answer as for a hash that names nothing, so a link tells nobody
// whether a book exists or whose it is. A private book's links are therefore
// personal bookmarks.
//
// A material id in the path (/read/<id>) is unchanged: /api/read/[id] already
// answers only its owner.

export const BOOK_HASH = /^[0-9a-f]{16}$/;

export const isBookHash = (id: string) => BOOK_HASH.test(id);

export type ReadTarget =
  /** An ordinary material id: the page loads it (the API checks its owner). */
  | { kind: "material"; id: string }
  /** A content hash this user has a material for: go to that material. */
  | { kind: "redirect"; id: string }
  /** A content hash with no access: 404. */
  | { kind: "none" };

/**
 * What /read/<id> opens. `findByHash` looks only among `userId`'s own
 * materials and returns that user's material id, or null.
 */
export async function resolveReadId(
  id: string,
  userId: string | null | undefined,
  findByHash: (userId: string, hash: string) => Promise<string | null>,
): Promise<ReadTarget> {
  if (!isBookHash(id)) return { kind: "material", id };
  if (!userId) return { kind: "none" };
  const own = await findByHash(userId, id);
  return own ? { kind: "redirect", id: own } : { kind: "none" };
}
