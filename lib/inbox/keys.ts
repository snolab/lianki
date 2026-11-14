/**
 * Where an inbox file lives in R2 and how it is sent back. The key never
 * holds the file's name (a user's text): `inbox/<user id>/<yyyy>/<mm>/<id>`,
 * the id random. The name goes only into Content-Disposition, encoded.
 */
import { INBOX_PREFIX } from "./config";
import { INLINE_TYPES } from "./sniff";

/** A new item id: 20 random lowercase hex-ish characters (no dashes). */
export function newInboxId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 20);
}

/** An item id as newInboxId makes it (anything else is refused before any lookup). */
export const isInboxId = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{20}$/.test(v);

/** A user id safe inside a key (better-auth ids are [A-Za-z0-9]). */
const safeUser = (u: string) => {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(u)) throw new Error("bad user id");
  return u;
};

/** The R2 key of one item: under INBOX_PREFIX, per user, per UTC month. */
export function inboxKey(userId: string, id: string, at: number): string {
  if (!isInboxId(id)) throw new Error("bad inbox id");
  const d = new Date(at);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${INBOX_PREFIX}${safeUser(userId)}/${d.getUTCFullYear()}/${mm}/${id}`;
}

/**
 * The response headers for a stored file: its sniffed type, never sniffed
 * again by the browser, a sandbox CSP, no browser HTTP cache across accounts;
 * inline only for a
 * safe image type, otherwise an attachment (so nothing executes or renders).
 */
export function fileHeaders(item: { name: string; type: string; size: number }): Headers {
  const inline = INLINE_TYPES.has(item.type);
  const ascii = item.name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const h = new Headers({
    "content-type": item.type,
    "content-length": String(item.size),
    "content-disposition": `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(item.name)}`,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "cache-control": "private, no-store",
  });
  return h;
}
