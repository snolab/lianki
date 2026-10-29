import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { dbBackend, getD1 } from "@/lib/d1";
import { INVITE_COOKIE, INVITE_COOKIE_MAX_AGE_S } from "@/lib/referrals/cookie";
import { normaliseCode } from "@/lib/referrals/rules";
import { inviterForCode } from "@/lib/referrals/store";

/**
 * An invite link, lianki.com/i/CODE. Remembers the code in a cookie and sends a
 * signed-out visitor to sign in; the claim happens once the account exists
 * (InviteClaim in the app layout). A signed-in visitor is already a user, so
 * the invite cannot apply — they land on /membership instead.
 */
export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const origin = new URL(req.url).origin;
  const code = normaliseCode((await params).code);
  const session = await auth.api.getSession({ headers: await headers() });
  if (session?.user) return NextResponse.redirect(`${origin}/membership`, 302);

  const res = NextResponse.redirect(`${origin}/sign-in?invited=1`, 302);
  if (code && dbBackend() === "d1" && (await inviterForCode(getD1(), code))) {
    res.cookies.set(INVITE_COOKIE, code, {
      path: "/",
      maxAge: INVITE_COOKIE_MAX_AGE_S,
      sameSite: "lax",
      secure: origin.startsWith("https:"),
      httpOnly: true,
    });
  }
  return res;
}
