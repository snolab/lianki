import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend, getD1 } from "@/lib/d1";
import { sendEmail, type SendEmailInput } from "@/lib/email";
import {
  templatesGet,
  templatesPost,
  type TemplatesDb,
  type TemplatesDeps,
} from "@/lib/mail-templates/route";
import { isDev } from "@/lib/permissions";
import { isLocalOrigin } from "@/lib/referrals/local-origin";

/**
 * The mail template store for /dev/templates (lib/mail-templates/route.ts,
 * docs/mail-templates.md). Developers only, 404 for anyone else.
 */
type User = Awaited<ReturnType<typeof authUserOrNull>>;
const caller = (u: User) => (u?.id && u.email ? { id: u.id, email: u.email } : null);

const origin = () => process.env.BETTER_AUTH_BASE_URL ?? "https://lianki.com";

/** A server on this machine never mails: the test send is a stub that logs one line, no address. */
async function stubSend(_mail: SendEmailInput) {
  console.log(JSON.stringify({ event: "mail.template.stub-send" }));
  return { id: `stub-${crypto.randomUUID()}` };
}

const deps: TemplatesDeps = {
  db: () => (dbBackend() === "d1" ? (getD1() as unknown as TemplatesDb) : null),
  send: (mail) => (isLocalOrigin(origin()) ? stubSend(mail) : sendEmail(mail)),
};

export async function GET(req: Request) {
  const u = await authUserOrNull();
  return templatesGet(req, isDev(u?.email) ? caller(u) : null, deps);
}

export async function POST(req: Request) {
  const u = await authUserOrNull();
  return templatesPost(req, isDev(u?.email) ? caller(u) : null, deps);
}
