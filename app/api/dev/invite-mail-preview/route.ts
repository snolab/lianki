import { NextResponse } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend } from "@/lib/d1";
import { isAdmin } from "@/lib/permissions";
import { renderFor } from "@/lib/referrals/email-invite";
import { emailInviteDeps } from "@/lib/referrals/email-invite-deps";
import { mailTemplateLocale } from "@/lib/signup-locale";

/**
 * Admin only (404 for anyone else): the invite email as the signed-in admin's
 * friend would get it — his name, his account language, his invite code —
 * with placeholder opt-out links. Sends nothing.
 *
 *   ?format=html (default) | text | json   ?locale=<tag> to override the language
 */
export async function GET(req: Request) {
  const user = await authUserOrNull();
  if (!user?.id || !isAdmin(user.email) || dbBackend() !== "d1")
    return new NextResponse(null, { status: 404 });
  const q = new URL(req.url).searchParams;
  const locale = mailTemplateLocale(q.get("locale")) ?? undefined;
  const mail = await renderFor(emailInviteDeps, user.id, { locale });
  const format = q.get("format") ?? "html";
  if (format === "json") return NextResponse.json(mail);
  if (format === "text")
    return new NextResponse(`Subject: ${mail.subject}\n\n${mail.text}`, {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  const head = Object.entries(mail.headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(mail.subject)}</title>` +
      `<pre style="white-space:pre-wrap;font-size:12px;padding:8px;border-bottom:1px solid oklch(0.85 0 0)">Subject: ${esc(mail.subject)}\nLanguage: ${mail.locale}\n${esc(head)}</pre>${mail.html}`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}
