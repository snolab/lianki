// A Google Docs link → the document id, or null. Strict on purpose: the
// server fetches only `https://docs.google.com/document/d/<id>/export`, built
// from the id alone, so a user-supplied URL is never fetched as given (no
// SSRF). Only Google Docs documents: not Sheets, Slides, Drive files, or
// "published to the web" links (/document/d/e/…).

/** Google document ids: URL-safe base64, 25+ characters in practice (44 today). */
const ID = /^[A-Za-z0-9_-]{25,128}$/;

export function gdocIdOf(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (!raw || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.hostname !== "docs.google.com" || url.port || url.username || url.password) return null;
  // /document/d/<id>/… or a signed-in account's /document/u/<n>/d/<id>/…
  const m = /^\/document\/(?:u\/\d{1,2}\/)?d\/([^/]+)(?:\/.*)?$/.exec(url.pathname);
  if (!m || !ID.test(m[1])) return null;
  return m[1];
}

/** The canonical link stored with the book. */
export function gdocUrlOf(id: string): string {
  return `https://docs.google.com/document/d/${id}/edit`;
}

/** The only URL the server fetches for a document: its HTML export. */
export function gdocExportUrl(id: string): string {
  return `https://docs.google.com/document/d/${id}/export?format=html`;
}

/** The material's source key (read_materials.source_key): one book per doc per user. */
export function gdocSourceKey(id: string): string {
  return `gdoc:${id}`;
}
