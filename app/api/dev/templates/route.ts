import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend, getD1 } from "@/lib/d1";
import { localOrSend } from "@/lib/mail-log/deliver";
import {
  templatesGet,
  templatesPost,
  type TemplatesDb,
  type TemplatesDeps,
} from "@/lib/mail-templates/route";
import { isDev } from "@/lib/permissions";

/**
 * The mail template store for /dev/templates (lib/mail-templates/route.ts,
 * docs/mail-templates.md). Developers only, 404 for anyone else.
 */
type User = Awaited<ReturnType<typeof authUserOrNull>>;
const caller = (u: User) => (u?.id && u.email ? { id: u.id, email: u.email } : null);

const deps: TemplatesDeps = {
  db: () => (dbBackend() === "d1" ? (getD1() as unknown as TemplatesDb) : null),
  // A server on this machine never mails: the test send is a stub that logs
  // one line, no address. Logged in the send log either way (lib/mail-log).
  send: localOrSend("mail.template.stub-send"),
};

export async function GET(req: Request) {
  const u = await authUserOrNull();
  return templatesGet(req, isDev(u?.email) ? caller(u) : null, deps);
}

export async function POST(req: Request) {
  const u = await authUserOrNull();
  return templatesPost(req, isDev(u?.email) ? caller(u) : null, deps);
}
