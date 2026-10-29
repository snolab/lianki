import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import { auth } from "@/auth";
import { dbBackend, getD1 } from "@/lib/d1";
import { INVITE_COOKIE } from "@/lib/referrals/cookie";
import { normaliseCode } from "@/lib/referrals/rules";
import { claimInvite, inviteSummary, type D1WithBatch } from "@/lib/referrals/store";

async function signedIn() {
  const session = await auth.api.getSession({ headers: await headers() });
  return session?.user ?? null;
}

/** The signed-in user's invite link and how their invites are doing. */
export async function GET() {
  if (dbBackend() !== "d1") return NextResponse.json({ error: "Unavailable" }, { status: 503 });
  const user = await signedIn();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(await inviteSummary(getD1() as unknown as D1WithBatch, user.id));
}

/** Claim the invite an /i/CODE link left in a cookie. The cookie is cleared either way. */
export async function POST() {
  if (dbBackend() !== "d1") return NextResponse.json({ error: "Unavailable" }, { status: 503 });
  const user = await signedIn();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const jar = await cookies();
  const code = normaliseCode(jar.get(INVITE_COOKIE)?.value);
  jar.delete(INVITE_COOKIE);
  if (!code) return NextResponse.json({ status: "rejected", reason: "no invite" });
  const result = await claimInvite(getD1() as unknown as D1WithBatch, user.id, code);
  return NextResponse.json(result);
}
