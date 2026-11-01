/**
 * Who may open a debug socket (debug.ts). Kept out of index.ts: a Worker's
 * entry module may export only handlers and Durable Object classes.
 */
import { type Identity, avatarUrl, isUserId } from "../../../lib/dev-eval";
import {
  type JtiStore,
  PARTNER_SUBPROTOCOL,
  PARTNER_TICKET_AUD,
  importTicketPublicKey,
  verifySttTicket,
} from "../../../lib/stt-ticket";

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
 * The split is strict both ways: a socket from https://lianki.com is judged on
 * its cookie alone (debugIdentity; a ticket there counts for nothing), and a
 * socket from any other origin on its ticket alone (a cookie there counts for
 * nothing). No Origin at all (not a browser) is refused here too.
 */
export const EMBED_HEADER = "x-debug-embed";

/** The ticket's single-use id and expiry, for the hub to burn; null = refuse. */
export type PartnerTicket = { jti: string; exp: number };

/** Seen in this isolate (the hub also burns each jti in its storage, across isolates). */
const seenHere: JtiStore = new Map();

export async function partnerTicket(
  req: Request,
  pub: string | undefined,
  seen: JtiStore = seenHere,
  now: number = Date.now(),
): Promise<PartnerTicket | null> {
  const origin = req.headers.get("origin");
  if (!origin || origin === DEBUG_ORIGIN || !pub) return null;
  const offered = (req.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (offered.length !== 2 || offered[0] !== PARTNER_SUBPROTOCOL) return null;
  try {
    const key = await importTicketPublicKey(pub);
    const r = await verifySttTicket(offered[1], key, seen, now, PARTNER_TICKET_AUD);
    return r.ok ? { jti: r.payload.jti, exp: r.payload.exp } : null;
  } catch {
    return null;
  }
}
