import { NextResponse } from "next/server";
import { getAuth } from "@/auth";
import { sessionLive } from "@/lib/debug-session";
import { isOwner } from "@/lib/owner";
import { flushSignedOutSoon } from "@/lib/push-signed-out";

/**
 * POST {user, session} → {live}: is the owner's sign-in session with that tag
 * still in the auth db, unexpired? lianki-push's debug hub asks this over its
 * MAIN binding right before each eval-grant renewal, and renews only on
 * `live: true` (docs/monitoring.md, "Renewal"). Answers `false` for anyone
 * but the owner and for anything malformed; the tag is a SHA-256 of a session
 * id, so the answer reveals nothing to someone who does not hold one. Also a
 * moment to retry sign-out notices still in the outbox.
 */
export const POST = async (req: Request) => {
  let body: { user?: unknown; session?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {}
  const ctx = await (await getAuth()).$context;
  const live = await sessionLive(body.user, body.session, {
    emailOf: async (id) => (await ctx.internalAdapter.findUserById(id))?.email ?? null,
    sessionsOf: (id) => ctx.internalAdapter.listSessions(id),
    isOwner,
  });
  flushSignedOutSoon();
  return NextResponse.json({ live }, { headers: { "cache-control": "no-store" } });
};
