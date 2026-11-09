import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend, getD1 } from "@/lib/d1";
import { localOrSend } from "@/lib/mail-log/deliver";
import { mailsGet, mailsPost, type MailsDb, type MailsDeps } from "@/lib/mail-log/route";
import { isDev } from "@/lib/permissions";

/**
 * The send log for /dev/mails (lib/mail-log/route.ts, docs/mail-templates.md,
 * "Send log"). Developers only, 404 for anyone else.
 */
type User = Awaited<ReturnType<typeof authUserOrNull>>;
const caller = (u: User) => (u?.id ? { id: u.id } : null);

const deps: MailsDeps = {
  db: () => (dbBackend() === "d1" ? (getD1() as unknown as MailsDb) : null),
  // A server on this machine never mails: a resend there is a stub (logged, no address).
  send: localOrSend("mail-log.stub-send"),
  origin: () => process.env.BETTER_AUTH_BASE_URL ?? "https://lianki.com",
  secret: () => process.env.AUTH_SECRET,
};

export async function GET(req: Request) {
  const u = await authUserOrNull();
  return mailsGet(req, isDev(u?.email) ? caller(u) : null, deps);
}

export async function POST(req: Request) {
  const u = await authUserOrNull();
  return mailsPost(req, isDev(u?.email) ? caller(u) : null, deps);
}
