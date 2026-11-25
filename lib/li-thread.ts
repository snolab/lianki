/**
 * Per-site Li threads for the userscript pill (docs/userscript-li-chat.md,
 * "Per-site threads"; flag `ext.pill-chat-per-origin`).
 *
 * Each website origin the pill opens Li on gets its own thread under the
 * account: `<base>~<hash>`, where `base` is the account's own thread
 * ("owner", or the D1 user id) and `hash` is an HMAC of base + origin under a
 * server key. The id never spells the origin, and nobody without the key can
 * test a guess of it; the origin itself is kept only beside the thread, for
 * the account's own list of sites (the hub's `subt:` record), and only as an
 * origin: scheme, host, port. Never a path or a query.
 *
 * lianki.com computes the hash when it mints the ticket, and signs it in
 * (`th`) with the origin (`ho`); lianki-push never needs the key. A sub-thread
 * is reachable only with a ticket that names it, or from the account's own
 * lianki.com session for a thread the hub already holds under that account.
 *
 * Pure: shared by the routes, lianki-push and the tests.
 */
import { b64url } from "./stt-ticket";

/** The flag: on = each site gets its own thread (default off: one thread, as before). */
export const PER_ORIGIN_FLAG = "ext.pill-chat-per-origin";
/** Between the account's thread and the site's hash. Never in a user id or a hash. */
export const SUB_SEP = "~";
/**
 * The userscript names the top window's origin with this header on its ticket
 * request (GM_xmlhttpRequest, outside the page's realm: the page cannot set it).
 */
export const HOST_ORIGIN_HEADER = "x-lianki-host-origin";
/** The frame names the parent origin it saw at the handshake with this query parameter. */
export const HOST_ORIGIN_PARAM = "ho";
/** The longest origin a ticket carries (the ticket must stay under 512 characters). */
export const MAX_HOST_ORIGIN = 100;

const BASE_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** 16 bytes, base64url: 22 characters. */
const HASH_RE = /^[A-Za-z0-9_-]{22}$/;

/**
 * An origin as a ticket may carry it: http(s) only, no userinfo, written
 * exactly as `URL.origin` writes it (lowercase host, default port dropped).
 * Anything else, a path or a query included, is refused rather than cut down.
 */
export function hostOrigin(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw || raw.length > MAX_HOST_ORIGIN) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  return u.origin === raw ? raw : null;
}

/** Is this a site hash as the hub keeps it? */
export const isSubHash = (v: unknown): v is string => typeof v === "string" && HASH_RE.test(v);

/** The site's thread under an account's own thread. */
export function subThread(base: string, hash: string): string {
  if (!BASE_RE.test(base) || !isSubHash(hash)) throw new Error("li-thread: bad sub-thread");
  return `${base}${SUB_SEP}${hash}`;
}

/** `<base>~<hash>` → its parts; null for any other thread (the account's own included). */
export function parseSubThread(thread: unknown): { base: string; hash: string } | null {
  if (typeof thread !== "string") return null;
  const i = thread.indexOf(SUB_SEP);
  if (i < 1) return null;
  const base = thread.slice(0, i);
  const hash = thread.slice(i + 1);
  return BASE_RE.test(base) && isSubHash(hash) ? { base, hash } : null;
}

/** The account's own thread a thread belongs to (itself, unless it is a site's). */
export const baseThread = (thread: string) => parseSubThread(thread)?.base ?? thread;

const enc = (s: string) => new TextEncoder().encode(s);

/**
 * The HMAC key for site hashes, derived from a server secret (the routes pass
 * STT_TICKET_KEY's private part, so there is no new secret to keep). Changing
 * that key gives every site a new thread; the old ones stay readable in the
 * account's history.
 */
export async function threadHashKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error("li-thread: no secret");
  const raw = await crypto.subtle.digest("SHA-256", enc(`lianki-li-thread\n${secret}`));
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

/** STT_TICKET_KEY (a JWK) → the site-hash key; null when it is not set or not a JWK. */
export async function threadHashKeyFromJwk(jwk: string | undefined): Promise<CryptoKey | null> {
  if (!jwk) return null;
  try {
    const d = (JSON.parse(jwk) as { d?: unknown }).d;
    return typeof d === "string" && d ? await threadHashKey(d) : null;
  } catch {
    return null;
  }
}

/** The site's hash under an account: HMAC(base + "\n" + origin), first 16 bytes. */
export async function subThreadHash(key: CryptoKey, base: string, origin: string): Promise<string> {
  if (!BASE_RE.test(base) || hostOrigin(origin) !== origin)
    throw new Error("li-thread: bad base or origin");
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc(`${base}\n${origin}`)));
  return b64url(mac.slice(0, 16));
}

/**
 * With `ext.pill-chat-per-origin` on: the host origin the userscript named
 * (HOST_ORIGIN_HEADER, from its own GM request: the page cannot set it) and
 * that site's thread hash under `base`, to sign into the ticket. `null` = no
 * ticket (the header is missing or not a plain origin, or there is no key);
 * `{}` = the flag is off: an unbound ticket, the one thread as before.
 */
export async function siteBinding(
  req: Request,
  flagOn: boolean,
  base: string,
  threadKey: (() => Promise<CryptoKey | null>) | undefined,
): Promise<{ ho?: string; th?: string } | null> {
  if (!flagOn) return {};
  const ho = hostOrigin(req.headers.get(HOST_ORIGIN_HEADER));
  if (!ho) return null;
  const key = await threadKey?.();
  if (!key) return null;
  return { ho, th: await subThreadHash(key, base, ho) };
}

/** One site's thread in the account's list (lianki.com/chat/sites). */
export type SiteThread = {
  /** The site hash (the thread is `<base>~<id>`). */
  id: string;
  origin: string;
  /** When Li was first opened there, and when the thread last had a line (or a visit). */
  firstAt: number;
  at: number;
  last?: { text: string; from: string; at: number };
};

/** The hub's record beside a site's thread (`subt:<thread>`). */
export type SubThreadRecord = { origin: string; firstAt: number; at: number };
export const subRecordKey = (thread: string) => `subt:${thread}`;
