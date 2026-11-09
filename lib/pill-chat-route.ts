/**
 * GET /api/ext/pill-chat — is Li chat from the userscript pill on for this
 * account (docs/userscript-li-chat.md)? `{ on }`, always 200, never cached.
 *
 * On = the `ext.pill-chat` flag is on AND the caller may have a partner
 * ticket today: the owner (isDev), by session or by a chat token, exactly as
 * `POST /api/debug/partner-ticket` decides (lib/partner-ticket-auth.ts). The
 * first slice reuses that owner-only ticket, so nobody else could open the
 * chat anyway; the flag is the kill switch on top. The userscript asks on
 * lianki.com page loads (at most once a minute) and again right before it
 * opens the frame on another site, after the user allowed that site.
 *
 * Nothing secret in the answer: one boolean.
 */
import type { D1Like } from "@/lib/d1/types";
import { flagIn, type FlagValues } from "@/lib/flags";
import { partnerTokenEmail } from "@/lib/partner-ticket-auth";

export type PillChatRouteDeps = {
  backend: () => "mongodb" | "d1";
  d1: () => D1Like;
  sessionEmail: () => Promise<string | null>;
  isDev: (email: string | null) => Promise<boolean>;
  flags: () => Promise<FlagValues>;
  now?: () => number;
};

const json = (body: unknown) =>
  Response.json(body, { status: 200, headers: { "cache-control": "private, no-store" } });

export async function pillChatState(req: Request, deps: PillChatRouteDeps): Promise<Response> {
  if (!flagIn(await deps.flags(), "ext.pill-chat")) return json({ on: false });
  const email = (await partnerTokenEmail(req, deps)) ?? (await deps.sessionEmail());
  if (!email || !(await deps.isDev(email))) return json({ on: false });
  return json({ on: true });
}
