import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { headers } from "next/headers";
import { getUserMembership } from "@/lib/membership";
import { dbBackend, getD1 } from "@/lib/d1";
import { settleAsInvitee, type D1WithBatch } from "@/lib/referrals/store";

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // An invitee reading their status is when their inviter's reward is checked.
  if (dbBackend() === "d1") {
    await settleAsInvitee(getD1() as unknown as D1WithBatch, session.user.id).catch((e) =>
      console.error("[referral] settle:", e),
    );
  }

  try {
    const membership = await getUserMembership(session.user.id);
    return NextResponse.json({
      tier: membership.tier,
      trialEndsAt: membership.trialEndsAt?.toISOString(),
      proEndsAt: membership.proEndsAt?.toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "User not found") {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
