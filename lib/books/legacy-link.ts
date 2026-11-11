// The old catalogue links /books/<lang>/<slug> (before 2026-11-10, when the
// catalogue moved to /library and /books became the user's own shelf; owner,
// docs/books-plan.md, "/library and /books"). Saved links, shares and the
// reader's source notes still carry them, so they never break:
//
// - the book is on the viewer's shelf (signed in, `books.mine` on, they added
//   it): the page stays at /books/<lang>/<slug>, as their own book;
// - otherwise (signed out, not added, `books.mine` off): a 308 to
//   /library/<lang>/<slug>, the query kept, where it can be added.
//
// The answer depends on the viewer, so the redirect is never cached: the page
// is dynamic (Cache-Control: private, no-store), and it is not a MOVED_ROUTES
// row (lib/moved-routes.ts holds unconditional moves only). Pure: no I/O.

import { normaliseSlug } from "./slug";

export type LegacyBookTarget = { stay: true } | { stay: false; href: string };

export function legacyBookTarget(input: {
  lang: string;
  /** The path segment as the route got it (maybe percent-encoded). */
  slug: string;
  /** The query string, with or without its "?". */
  search?: string;
  /** "<lang>/<slug>" → the viewer's own read_material id (lib/books/owned.ts). */
  owned: Record<string, string>;
  /** Signed in and `books.mine` on (lib/books/gate.ts). */
  shelf: boolean;
}): LegacyBookTarget {
  const slug = normaliseSlug(input.slug);
  if (input.shelf && slug && input.owned[`${input.lang}/${slug}`]) return { stay: true };
  const q = (input.search ?? "").replace(/^\?/, "");
  const seg = slug ?? safeDecode(input.slug);
  const href = `/library/${encodeURIComponent(input.lang)}/${encodeURIComponent(seg)}`;
  return { stay: false, href: q ? `${href}?${q}` : href };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
