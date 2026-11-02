import { NextResponse } from "next/server";
import { makeSignature } from "better-auth/crypto";
import { getAuth } from "@/auth";
import { ownerEmails } from "@/lib/owner";
import { devWholePageLoginAllowed } from "@/lib/dev-whole-page";

/**
 * The whole-page dev server's sign-in (docs/dev-whole-page.md): a session for
 * the owner, and nobody else, minted for the guard after it consumed a one-time
 * enter link. Its sign-in endpoints are closed, so this is the only way in.
 *
 * Inert everywhere else: 404 unless the process is `next dev` started by
 * scripts/dev/whole-page.ts (LIANKI_DEV_WHOLE_PAGE=1 + its guard secret) and
 * the request carries that secret, which only the guard proxy adds (and strips
 * from anything incoming). Production sets neither, so it always 404s there.
 */
export const POST = async (req: Request) => {
  if (!devWholePageLoginAllowed(process.env, req.headers)) {
    return new NextResponse(null, { status: 404 });
  }
  const email = ownerEmails()[0];
  if (!email) return NextResponse.json({ error: "OWNER_EMAILS is empty" }, { status: 500 });

  const ctx = await (await getAuth()).$context;
  const found = await ctx.internalAdapter.findUserByEmail(email);
  if (!found?.user) return NextResponse.json({ error: "owner has no account" }, { status: 404 });

  const session = await ctx.internalAdapter.createSession(found.user.id);
  const { name, attributes } = ctx.authCookies.sessionToken;
  const value = `${session.token}.${await makeSignature(session.token, ctx.secret)}`;
  const res = NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  res.cookies.set(name, value, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: Boolean(attributes.secure),
    maxAge: attributes.maxAge ?? 7 * 24 * 60 * 60,
  });
  return res;
};
