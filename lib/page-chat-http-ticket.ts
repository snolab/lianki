/** Private Worker-to-Worker authority. It never travels to the userscript or host page. */
import { b64url, fromB64url, isTicketSub } from "./stt-ticket";
import { parsePageChatHttpInput, type PageChatHttpAction } from "./page-chat-http-wire";
export const PAGE_CHAT_HTTP_AUD = "lianki-page-chat-http";
export type PageChatHttpClaims = {
  aud: typeof PAGE_CHAT_HTTP_AUD;
  jti: string;
  iat: number;
  exp: number;
  sub: string;
  own?: true;
  ho: string;
  th: string;
  digest: string;
};
const bytes = (s: string) => new TextEncoder().encode(s);
export async function pageChatActionDigest(action: PageChatHttpAction): Promise<string> {
  return b64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(JSON.stringify(action)))),
  );
}
function validSite(ho: unknown, th: unknown): boolean {
  if (typeof ho !== "string" || typeof th !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(th))
    return false;
  try {
    const u = new URL(ho);
    return (
      (u.protocol === "https:" || u.protocol === "http:") &&
      ho.length <= 100 &&
      u.origin === ho &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}
export async function signPageChatHttpTicket(
  key: CryptoKey,
  who: { sub: string; own?: true; ho: string; th: string },
  action: PageChatHttpAction,
  now = Date.now(),
): Promise<string> {
  if (!isTicketSub(who.sub) || !validSite(who.ho, who.th))
    throw new Error("invalid chat principal");
  const iat = Math.floor(now / 1000);
  const p: PageChatHttpClaims = {
    aud: PAGE_CHAT_HTTP_AUD,
    jti: b64url(crypto.getRandomValues(new Uint8Array(16))),
    iat,
    exp: iat + 60,
    sub: who.sub,
    ...(who.own ? { own: true } : {}),
    ho: who.ho,
    th: who.th,
    digest: await pageChatActionDigest(action),
  };
  const body = b64url(bytes(JSON.stringify(p)));
  return `${body}.${b64url(new Uint8Array(await crypto.subtle.sign("Ed25519", key, bytes(body))))}`;
}
/** Replay consumption belongs to the destination Durable Object, after verification. */
export async function verifyPageChatHttpTicket(
  ticket: string,
  key: CryptoKey,
  action: PageChatHttpAction,
  now = Date.now(),
): Promise<PageChatHttpClaims | null> {
  if (ticket.length > 1200) return null;
  const parts = ticket.split(".");
  if (parts.length !== 2) return null;
  try {
    if (
      !(await crypto.subtle.verify(
        "Ed25519",
        key,
        fromB64url(parts[1]) as BufferSource,
        bytes(parts[0]),
      ))
    )
      return null;
    const p = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(fromB64url(parts[0])),
    ) as PageChatHttpClaims;
    const t = Math.floor(now / 1000);
    if (
      p.aud !== PAGE_CHAT_HTTP_AUD ||
      !isTicketSub(p.sub) ||
      !validSite(p.ho, p.th) ||
      !/^[A-Za-z0-9_-]{22}$/.test(p.jti) ||
      !Number.isSafeInteger(p.iat) ||
      !Number.isSafeInteger(p.exp) ||
      p.exp - p.iat !== 60 ||
      p.iat > t + 5 ||
      p.exp < t ||
      (p.own !== undefined && p.own !== true) ||
      parsePageChatHttpInput(action)?.op === "hello" ||
      !parsePageChatHttpInput(action) ||
      p.digest !== (await pageChatActionDigest(action))
    )
      return null;
    return p;
  } catch {
    return null;
  }
}
