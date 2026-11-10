// A catalogue book's slug: its title in the original language and script
// (owner, 2026-11-05: "slug用书名原语言 不强制英文"). One generic rule for every
// script: NFC, lower case where the script has case, letters, marks and digits
// kept, every run of anything else one "-" (apostrophes kept as "'", as in
// "l'optimisme"). Made once when an entry is added and stored with it; never
// recomputed, so editing a title never moves a book's URL.
//
// /library/<lang>/<slug> links percent-encode the slug (bookHref); the route
// decodes and NFC-normalises what it gets (normaliseSlug), so a slug typed,
// pasted or encoded by any browser resolves to the same entry.

/** A stored slug: letter/mark/digit runs of any script, joined by "-". */
export const SLUG_RE =
  /^[\p{L}\p{M}\p{N}]+(?:'[\p{L}\p{M}\p{N}]+)*(?:-[\p{L}\p{M}\p{N}]+(?:'[\p{L}\p{M}\p{N}]+)*)*$/u;

const MAX_SLUG = 80;

/** The title (or any text) as a slug; "" when nothing of it is a letter or digit. */
export function slugOf(text: string): string {
  const s = text
    .normalize("NFC")
    .toLocaleLowerCase("und")
    .replace(/[’ʼ‘`´]/g, "'")
    // An apostrophe stays only between two letters (l'optimisme); else it is a separator.
    .replace(/'(?![\p{L}\p{M}\p{N}])|(?<![\p{L}\p{M}\p{N}])'/gu, "-")
    .replace(/[^\p{L}\p{M}\p{N}']+/gu, "-")
    .replace(/^-+|-+$/g, "");
  if (s.length <= MAX_SLUG) return s;
  const cut = s.slice(0, MAX_SLUG);
  const dash = cut.lastIndexOf("-");
  return (dash > 20 ? cut.slice(0, dash) : cut).replace(/-+$/, "");
}

/**
 * A new entry's slug: its title's, or, when another entry has it, the title's
 * with the first meaningful suffix that is free (the author, the year, the
 * translator: whatever the caller passes, in order). Null when all are taken.
 */
export function newSlug(title: string, taken: Set<string>, suffixes: string[] = []): string | null {
  const base = slugOf(title);
  if (!base) return null;
  if (!taken.has(base)) return base;
  for (const s of suffixes) {
    const tail = slugOf(s);
    if (!tail) continue;
    const slug = `${base}-${tail}`;
    if (!taken.has(slug)) return slug;
  }
  return null;
}

/** A slug from a URL segment (encoded or not) in its stored form, or null. */
export function normaliseSlug(segment: string): string | null {
  let s = segment;
  try {
    s = decodeURIComponent(segment);
  } catch {
    return null;
  }
  s = s
    .normalize("NFC")
    .toLocaleLowerCase("und")
    .replace(/[’ʼ]/g, "'");
  return SLUG_RE.test(s) ? s : null;
}

/** The catalogue page of a book: /library/<lang>/<slug>, encoded (old /books/… links: app/(app)/books/[lang]/[slug]). */
export function bookHref(b: { lang: string; slug: string }): string {
  return `/library/${encodeURIComponent(b.lang)}/${encodeURIComponent(b.slug)}`;
}
