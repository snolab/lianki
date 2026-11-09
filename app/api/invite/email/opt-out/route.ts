import { dbBackend } from "@/lib/d1";
import { inviteOptOut, optOutGet } from "@/lib/referrals/email-invite";
import { emailInviteDeps } from "@/lib/referrals/email-invite-deps";

const off = () => Response.json({ error: "Not found" }, { status: 404 });

/** Unsubscribe / report from an invite mail: RFC 8058 one-click or the opt-out page. No sign-in. */
export const POST = (req: Request) =>
  dbBackend() === "d1" ? inviteOptOut(req, emailInviteDeps) : off();

/** A GET changes nothing: it opens the opt-out page. */
export const GET = (req: Request) => optOutGet(req, emailInviteDeps.origin());
