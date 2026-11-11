import { dbBackend } from "@/lib/d1";
import { emailInviteStatus, sendEmailInvite } from "@/lib/referrals/email-invite";
import { emailInviteDeps } from "@/lib/referrals/email-invite-deps";

const off = () => Response.json({ error: "not-found" }, { status: 404 });

/** May this user invite by email; today's remaining; their own masked history. */
export const GET = () => (dbBackend() === "d1" ? emailInviteStatus(emailInviteDeps) : off());

/** Invite one friend by email (lib/referrals/email-invite.ts). */
export const POST = (req: Request) =>
  dbBackend() === "d1" ? sendEmailInvite(req, emailInviteDeps) : off();
