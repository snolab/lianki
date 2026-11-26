/** Private main-Worker -> permission authority capability. Never returned to a website. */
import { b64url, fromB64url, isTicketSub } from "./stt-ticket";
import { parseSitePermissionAction, type SitePermissionAction } from "./site-permission-wire";
export const SITE_ACTION_AUD = "lianki-site-action-v1";
export const SITE_ACTION_PATH = "/internal/site-permissions";
export const SITE_ACTION_HEADER = "x-lianki-site-action";
export type SiteActionClaims = {
  aud: typeof SITE_ACTION_AUD;
  sub: string;
  jti: string;
  iat: number;
  exp: number;
  mode: "manage" | "page.read" | "status";
  origin: string | null;
  revision: number | null;
  digest: string;
};
const encode = (v: string) => new TextEncoder().encode(v);
export async function siteActionDigest(action: SitePermissionAction): Promise<string> {
  const parsed = parseSitePermissionAction(action);
  if (!parsed) throw Error("invalid site action");
  return b64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encode(JSON.stringify(parsed)))),
  );
}
export async function signSiteAction(
  key: CryptoKey,
  sub: string,
  raw: SitePermissionAction,
  now = Date.now(),
): Promise<string> {
  const action = parseSitePermissionAction(raw);
  if (!action || !isTicketSub(sub)) throw Error("invalid site authority");
  const iat = Math.floor(now / 1000);
  const claims: SiteActionClaims = {
    aud: SITE_ACTION_AUD,
    sub,
    jti: b64url(crypto.getRandomValues(new Uint8Array(16))),
    iat,
    exp: iat + 60,
    mode: action.op === "consume" ? "page.read" : action.op === "inspect" ? "status" : "manage",
    origin: "origin" in action ? action.origin : null,
    revision: action.op === "consume" ? action.revision : null,
    digest: await siteActionDigest(action),
  };
  const body = b64url(encode(JSON.stringify(claims)));
  return (
    body + "." + b64url(new Uint8Array(await crypto.subtle.sign("Ed25519", key, encode(body))))
  );
}
export async function verifySiteAction(
  ticket: string,
  key: CryptoKey,
  raw: SitePermissionAction,
  now = Date.now(),
): Promise<SiteActionClaims | null> {
  try {
    const action = parseSitePermissionAction(raw);
    if (!action || ticket.length > 1600) return null;
    const parts = ticket.split(".");
    if (parts.length !== 2) return null;
    if (
      !(await crypto.subtle.verify(
        "Ed25519",
        key,
        fromB64url(parts[1]) as BufferSource,
        encode(parts[0]),
      ))
    )
      return null;
    const c = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(fromB64url(parts[0])),
    ) as SiteActionClaims;
    const t = Math.floor(now / 1000);
    if (
      c.aud !== SITE_ACTION_AUD ||
      !isTicketSub(c.sub) ||
      !/^[A-Za-z0-9_-]{22}$/.test(c.jti) ||
      !Number.isSafeInteger(c.iat) ||
      !Number.isSafeInteger(c.exp) ||
      c.exp - c.iat !== 60 ||
      c.iat > t + 5 ||
      c.exp <= t ||
      c.mode !==
        (action.op === "consume" ? "page.read" : action.op === "inspect" ? "status" : "manage") ||
      c.origin !== ("origin" in action ? action.origin : null) ||
      c.revision !== (action.op === "consume" ? action.revision : null) ||
      c.digest !== (await siteActionDigest(action))
    )
      return null;
    return c;
  } catch {
    return null;
  }
}

/** Non-authorizing, per-account/site identity binding; prevents a pending selection crossing account switches. */
export async function siteReadAccountBinding(
  key: CryptoKey,
  sub: string,
  origin: string,
): Promise<string> {
  const signature = await crypto.subtle.sign(
    "Ed25519",
    key,
    encode("lianki-site-read-binding-v1\n" + sub + "\n" + origin),
  );
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", signature)).slice(0, 16));
}
