import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { headers } from "next/headers";
import { getUserMembership } from "@/lib/membership";

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const membership = await getUserMembership(session.user.id);
    return NextResponse.json({
      tier: membership.tier,
      trialEndsAt: membership.trialEndsAt?.toISOString(),
      proEndsAt: membership.proEndsAt?.toISOString(),
    });
  } catch (error: any) {
    if (error.message === "User not found") {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
