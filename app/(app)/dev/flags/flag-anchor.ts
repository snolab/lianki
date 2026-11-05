/** How long a card reached by a link stays highlighted. */
export const FLAG_HIGHLIGHT_MS = 2400;

/**
 * The flag key a location hash names, for links like /dev/flags#books.catalogue.
 * Browsers may percent-encode the fragment; a malformed one is used as written.
 */
export function flagKeyFromHash(hash: string): string | null {
  const raw = hash.replace(/^#/, "");
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Scrolls the card that the hash names into view and returns its key, or null
 * when the hash names no card. Looks it up with getElementById: keys contain
 * dots, which a CSS selector would read as classes.
 */
export function scrollToFlag(
  doc: Pick<Document, "getElementById">,
  hash: string,
  reduceMotion: boolean,
): string | null {
  const key = flagKeyFromHash(hash);
  const el = key === null ? null : doc.getElementById(key);
  if (!el) return null;
  el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  return key;
}
