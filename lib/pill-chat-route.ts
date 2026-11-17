/**
 * GET /api/ext/pill-chat — is Li chat from the userscript pill on for this
 * account (docs/userscript-li-chat.md)? `{ on, ticket? }`, always 200, never
 * cached.
 *
 * - `ext.pill-chat` off: `{ on: false }` for everyone (the kill switch).
 * - The owner (isDev), by session or by a chat token: `{ on: true, ticket:
 *   "owner" }` — the partner ticket (`POST /api/debug/partner-ticket`, his own
 *   thread), exactly as before.
 * - Any other signed-in account: on only while `ext.pill-chat-users` is on
 *   too (M5, the owner's later decision): `{ on: true, ticket: "account" }` —
 *   the account-scoped ticket (`POST /api/chat/li-ticket`, lib/li-ticket-route.ts),
 *   that account's own thread only.
 * - Signed out: off (open question 2: no Li entry at all).
 *
 * The userscript asks on lianki.com page loads (at most once a minute) and
 * again right before it opens the frame on another site, after the user
 * allowed that site; the second answer also says which ticket to fetch.
 * Nothing secret in the answer.
 */
import type { D1Like } from "@/lib/d1/types";
import { flagIn, type FlagValues } from "@/lib/flags";
import { partnerTokenUser } from "@/lib/partner-ticket-auth";

/** Which ticket the userscript fetches: the owner's partner ticket, or the account's own. */
export type PillChatTicket = "owner" | "account";

export type PillChatUser = { id: string; email: string };

export type PillChatRouteDeps = {
  backend: () => "mongodb" | "d1";
  d1: () => D1Like;
  /** The signed-in session's account, or null. */
  sessionUser: () => Promise<PillChatUser | null>;
  isDev: (email: string | null) => Promise<boolean>;
  flags: () => Promise<FlagValues>;
  now?: () => number;
};

const json = (body: unknown) =>
  Response.json(body, { status: 200, headers: { "cache-control": "private, no-store" } });

/** Who may open Li from the pill, and with which ticket; null = nobody (off). */
export async function pillChatAccess(
  req: Request,
  deps: PillChatRouteDeps,
): Promise<{ user: PillChatUser; ticket: PillChatTicket } | null> {
  const flags = await deps.flags();
  if (!flagIn(flags, "ext.pill-chat")) return null;
  const user = (await partnerTokenUser(req, deps)) ?? (await deps.sessionUser());
  if (!user?.email) return null;
  if (await deps.isDev(user.email)) return { user, ticket: "owner" };
  return flagIn(flags, "ext.pill-chat-users") ? { user, ticket: "account" } : null;
}

export async function pillChatState(req: Request, deps: PillChatRouteDeps): Promise<Response> {
  const a = await pillChatAccess(req, deps);
  return json(a ? { on: true, ticket: a.ticket } : { on: false });
}
