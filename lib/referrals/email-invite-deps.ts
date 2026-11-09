import { authUserOrNull } from "@/app/signInEmail";
import { getD1 } from "@/lib/d1";
import { isEmailConfigured } from "@/lib/email";
import { localOrSend } from "@/lib/mail-log/deliver";
import { readFlags } from "@/lib/flags-store";
import { isAdmin } from "@/lib/permissions";
import type { EmailInviteDeps, InviteDb } from "./email-invite";
import { isLocalOrigin } from "./local-origin";

const origin = () => process.env.BETTER_AUTH_BASE_URL ?? "https://lianki.com";

/** The invite-by-email routes' dependencies (lib/referrals/email-invite.ts). */
export const emailInviteDeps: EmailInviteDeps = {
  who: async () => {
    const u = await authUserOrNull();
    return u?.id && u.email ? { id: u.id, email: u.email } : null;
  },
  db: () => getD1() as unknown as InviteDb,
  // A server on this machine (QA, `bun run dev`, wrangler dev) never mails a
  // friend: whatever .dev.vars holds, the send is a stub that logs one line
  // with no address. Every send, stub or real, gets its send-log row.
  send: localOrSend("invite-email.stub-send"),
  mailOn: () => isLocalOrigin(origin()) || isEmailConfigured(),
  secret: () => process.env.AUTH_SECRET,
  flags: () => readFlags(),
  isAdmin: (email) => isAdmin(email),
  origin,
};
