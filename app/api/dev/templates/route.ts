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
async function dev() {
  const user = await authUserOrNull();
  return isDev(user?.email) && user?.id && user.email ? { id: user.id, email: user.email } : null;
}

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

export const GET = async (req: Request) => templatesGet(req, await dev(), deps);

export const POST = async (req: Request) => templatesPost(req, await dev(), deps);
