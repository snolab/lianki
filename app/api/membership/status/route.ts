import { NextResponse } from "next/server";
import { authUser } from "@/app/signInEmail";
import { getUserMembership } from "@/lib/membership";

export async function GET() {
  try {
    const user = await authUser();
    const membership = await getUserMembership(user.id);

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
