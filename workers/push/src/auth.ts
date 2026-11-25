/**
 * Who may open a debug socket (debug.ts). Kept out of index.ts: a Worker's
 * entry module may export only handlers and Durable Object classes.
 */
import { type Identity, avatarUrl, isSessionTag, isUserId } from "../../../lib/dev-eval";
import { isBoxOrigin } from "../../../lib/box-oauth/rules";
import {
  BOX_CHAT_TICKET_AUD,
  type JtiStore,
  LI_CHAT_TICKET_AUD,
  PAGE_CHAT_TICKET_AUD,
  PARTNER_SUBPROTOCOL,
  PARTNER_TICKET_AUD,
  importTicketPublicKey,
  type SttTicketPayload,
  verifySttTicket,
} from "../../../lib/stt-ticket";
import { HOST_ORIGIN_PARAM, hostOrigin, isSubHash } from "../../../lib/li-thread";

type Fetcher = { fetch(url: string, init?: RequestInit): Promise<Response> };

/** The only origin a debug page may connect from. */
export const DEBUG_ORIGIN = "https://lianki.com";

/**
 * The owner's whole-page dev server (docs/dev-whole-page.md) proves itself
 * with this header instead of a lianki.com cookie (its sessions are signed with
 * a local secret). lianki-push only passes it on: the main Worker compares it
 * with DEV_BRIDGE_SECRET and answers with the owner, never anyone else.
 */
export const DEV_BRIDGE_HEADER = "x-lianki-dev-bridge";

/**
 * Who is this upgrade request, from a lianki.com page? The cookie is checked
 * by the main Worker itself (/api/debug/identity → {userId, email, owner} for
 * any signed-in user, 401 for a guest), so lianki-push holds no secret and no
 * copy of the owner list. null = refuse.
 */
export async function debugIdentity(
  req: Request,
  main: Fetcher | undefined,
): Promise<Identity | null> {
  if (req.headers.get("origin") !== DEBUG_ORIGIN) return null;
  const cookie = req.headers.get("cookie");
  const bridge = req.headers.get(DEV_BRIDGE_HEADER);
  if ((!cookie && !bridge) || !main) return null;
  try {
    const headers: Record<string, string> = bridge ? { [DEV_BRIDGE_HEADER]: bridge } : {};
    if (cookie) headers.cookie = cookie;
    const res = await main.fetch(`${DEBUG_ORIGIN}/api/debug/identity`, { headers });
    // A main Worker from before friends has no such route: ask the old
    // owner-only check, so deploying lianki-push first never locks the owner out.
    if (res.status === 404) return cookie ? await ownerFallback(main, cookie) : null;
    if (res.status !== 200) return null;
    const body = (await res.json()) as Partial<Record<keyof Identity, unknown>>;
    if (!isUserId(body.userId) || typeof body.email !== "string") return null;
    return {
      userId: body.userId,
      email: body.email,
      owner: body.owner === true,
      // For the chat's avatars; an older main Worker sends neither.
      ...(typeof body.name === "string" && body.name ? { name: body.name } : {}),
      ...(avatarUrl(body.image) ? { image: avatarUrl(body.image) } : {}),
      // The sign-in session (a hash) and its expiry: an eval grant's renewal is bound to it.
      ...(isSessionTag(body.session) ? { session: body.session } : {}),
      ...(typeof body.sessionUntil === "number" && Number.isFinite(body.sessionUntil)
        ? { sessionUntil: body.sessionUntil }
        : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The pre-friends check: /api/dev/whoami answers 200 {owner:true} for the
 * owner only. That is the owner (whose user id and email it does not say, and
 * the hub does not need for the owner thread); anything else is refused.
 */
async function ownerFallback(main: Fetcher, cookie: string): Promise<Identity | null> {
  const res = await main.fetch(`${DEBUG_ORIGIN}/api/dev/whoami`, { headers: { cookie } });
  if (res.status !== 200) return null;
  const body = (await res.json()) as { owner?: unknown };
  return body.owner === true ? { userId: "owner", email: "", owner: true } : null;
}

/**
 * The Learning Partner on another site (the userscript, docs/dev-debug-widget.md
 * "On every site"): its socket comes from the host site's origin with no
 * lianki.com cookie, and carries a 60 s owner ticket from lianki.com
 * (/api/debug/partner-ticket) in Sec-WebSocket-Protocol: `lianki-partner, <ticket>`.
 *
 * The split is strict both ways: a socket that offers the partner
 * subprotocol is judged on its ticket alone (a cookie there counts for
 * nothing), from any browser origin: the host site's shadow widget, or the
 * lianki.com frame, which is third-party there and so has no cookie. Any
 * other socket is judged on its cookie alone, and only from https://lianki.com.
 * No Origin at all (not a browser) is refused here too.
 */
export const EMBED_HEADER = "x-debug-embed";
/** Set only from a verified page-chat audience, never a client query/header. */
export const PAGE_CHAT_HEADER = "x-debug-page-chat";

/**
 * The ticket's single-use id and expiry, for the hub to burn; null = refuse.
 * `ho`/`th`: a pill ticket bound to one site (lib/li-thread.ts): its thread is
 * that site's under the account, nothing else.
 */
export type PartnerTicket = { jti: string; exp: number; ho?: string; th?: string };

/**
 * A site-bound ticket's thread hash and host origin, for the hub alone. Set
 * here after the ticket is verified, and deleted from every other request.
 */
export const SUB_THREAD_HEADER = "x-debug-sub-thread";
export const SUB_ORIGIN_HEADER = "x-debug-sub-origin";
/**
 * The main Worker's /api/chat/sites over the PUSH binding (answered on the
 * binding's hostname alone): an account's site threads (debug.ts subThreadsApi).
 */
export const SUB_THREADS_PATH = "/internal/sub-threads";

/**
 * A site-bound ticket (`ho` + `th`, lib/li-thread.ts) is good only from the
 * lianki.com frame (origin exactly DEBUG_ORIGIN), and only when the frame
 * names the same host origin in `?ho=`: the parent origin it saw at the
 * handshake (the browser's `event.origin`, frame-protocol.ts helloFrom),
 * never anything the page said. A ticket minted for site A, opened in a frame
 * on site B, is refused. `{}` = an unbound ticket (the one thread, as before);
 * null = refuse.
 */
export function ticketSite(
  req: Request,
  p: Pick<SttTicketPayload, "ho" | "th">,
): { ho?: string; th?: string } | null {
  if (p.ho === undefined && p.th === undefined) return {};
  const ho = hostOrigin(p.ho);
  if (!ho || !isSubHash(p.th)) return null;
  if (req.headers.get("origin") !== DEBUG_ORIGIN) return null;
  let said: string | null = null;
  try {
    said = new URL(req.url).searchParams.get(HOST_ORIGIN_PARAM);
  } catch {}
  return said === ho ? { ho, th: p.th } : null;
}

/** Seen in this isolate (the hub also burns each jti in its storage, across isolates). */
const seenHere: JtiStore = new Map();

/** Does this upgrade offer the partner subprotocol? Then it is judged on its ticket alone. */
export function offersPartner(req: Request): boolean {
  return (req.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .some((s) => s.trim() === PARTNER_SUBPROTOCOL);
}

/**
 * The owner's box (docs/box-oauth.md, "Chat on the owner's box"): which box
 * client a ticket socket is, for the hub alone. Set here after a box chat
 * ticket is verified, and deleted from every other request.
 */
export const BOX_HEADER = "x-debug-box";

/** A box chat ticket's single-use id, expiry and box client; null = refuse. */
export type BoxChatTicket = PartnerTicket & { cid: string };

const CLIENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * A box chat ticket (lianki.com/api/box/chat-ticket): the partner subprotocol,
 * the box audience, and taken only from the exact origin it names, which must
 * be a box's. A partner ticket is never one of these, nor the other way round.
 */
export async function boxChatTicket(
  req: Request,
  pub: string | undefined,
  seen: JtiStore = seenHere,
  now: number = Date.now(),
): Promise<BoxChatTicket | null> {
  const origin = req.headers.get("origin");
  // lianki.com signs a ticket only for a live binding's origin, which is
  // https://my-<hash|name>.lianki.com in production (a dev server's binding may be loopback).
  if (!origin || !pub || !isBoxOrigin(origin, true)) return null;
  const offered = (req.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (offered.length !== 2 || offered[0] !== PARTNER_SUBPROTOCOL) return null;
  try {
    const key = await importTicketPublicKey(pub);
    const r = await verifySttTicket(offered[1], key, seen, now, BOX_CHAT_TICKET_AUD);
    if (!r.ok || r.payload.org !== origin) return null;
    const cid = r.payload.cid;
    if (typeof cid !== "string" || !CLIENT_ID.test(cid)) return null;
    return { jti: r.payload.jti, exp: r.payload.exp, cid };
  } catch {
    return null;
  }
}

export async function partnerTicket(
  req: Request,
  pub: string | undefined,
  seen: JtiStore = seenHere,
  now: number = Date.now(),
): Promise<PartnerTicket | null> {
  const origin = req.headers.get("origin");
  // Any browser origin: the host site (shadow widget) or lianki.com (the frame,
  // third-party, so cookieless). Never without one: not a browser.
  if (!origin || !pub) return null;
  const offered = (req.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (offered.length !== 2 || offered[0] !== PARTNER_SUBPROTOCOL) return null;
  try {
    const key = await importTicketPublicKey(pub);
    const probe: JtiStore = new Map(seen);
    const r = await verifySttTicket(offered[1], key, probe, now, PARTNER_TICKET_AUD);
    if (!r.ok) return null;
    const site = ticketSite(req, r.payload);
    if (!site) return null;
    seen.set(r.payload.jti, r.payload.exp);
    return { jti: r.payload.jti, exp: r.payload.exp, ...site };
  } catch {
    return null;
  }
}

/** A Li chat ticket's single-use id, expiry and the account it names; null = refuse. */
export type LiChatTicket = PartnerTicket & { sub: string };

/**
 * A Li chat ticket (lianki.com/api/chat/li-ticket, docs/userscript-li-chat.md
 * M2): the partner subprotocol, the Li chat audience, an account id (`sub`),
 * and taken only from the lianki.com frame (origin exactly DEBUG_ORIGIN): the
 * host page never opens this socket itself. The socket is that account's own
 * thread, chat only (index.ts, debug.ts). Never an owner page: an owner
 * partner ticket is never one of these, nor the other way round.
 */
export async function liChatTicket(
  req: Request,
  pub: string | undefined,
  seen: JtiStore = seenHere,
  now: number = Date.now(),
): Promise<LiChatTicket | null> {
  if (req.headers.get("origin") !== DEBUG_ORIGIN || !pub) return null;
  const offered = (req.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (offered.length !== 2 || offered[0] !== PARTNER_SUBPROTOCOL) return null;
  try {
    const key = await importTicketPublicKey(pub);
    // Claims first on a copy of the store, so a ticket with a bad `sub` spends nothing.
    const probe: JtiStore = new Map(seen);
    const r = await verifySttTicket(offered[1], key, probe, now, LI_CHAT_TICKET_AUD);
    if (!r.ok || !isUserId(r.payload.sub)) return null;
    const site = ticketSite(req, r.payload);
    if (!site) return null;
    seen.set(r.payload.jti, r.payload.exp);
    return { jti: r.payload.jti, exp: r.payload.exp, sub: r.payload.sub, ...site };
  } catch {
    return null;
  }
}

/** Page-realm portable Li is always bound to this account and exact host site. */
export type PageChatTicket = PartnerTicket & { sub: string; owner: boolean; chatOnly: true };
export async function pageChatTicket(
  req: Request,
  pub: string | undefined,
  seen: JtiStore = seenHere,
  now: number = Date.now(),
): Promise<PageChatTicket | null> {
  if (req.headers.get("origin") !== DEBUG_ORIGIN || !pub) return null;
  const offered = (req.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (offered.length !== 2 || offered[0] !== PARTNER_SUBPROTOCOL) return null;
  try {
    const key = await importTicketPublicKey(pub);
    const r = await verifySttTicket(offered[1], key, new Map(seen), now, PAGE_CHAT_TICKET_AUD);
    if (
      !r.ok ||
      !isUserId(r.payload.sub) ||
      (r.payload.own !== undefined && r.payload.own !== true)
    )
      return null;
    const site = ticketSite(req, r.payload);
    if (!site?.ho || !site.th) return null;
    seen.set(r.payload.jti, r.payload.exp);
    return {
      jti: r.payload.jti,
      exp: r.payload.exp,
      sub: r.payload.sub,
      owner: r.payload.own === true,
      chatOnly: true,
      ...site,
    };
  } catch {
    return null;
  }
}
