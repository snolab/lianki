import { NextResponse } from "next/server";
import { authUser } from "@/app/signInEmail";
import { startTrial, getUserMembership } from "@/lib/membership";

export async function POST() {
  try {
    const user = await authUser();
    const membership = await getUserMembership(user.id);

    // Check if user already has or had a trial
    if (membership.trialEndsAt) {
      return NextResponse.json({ error: "You have already used your trial" }, { status: 400 });
    }

    // Check if user already has pro
    if (membership.tier === "pro") {
      return NextResponse.json({ error: "You already have Pro membership" }, { status: 400 });
    }

    await startTrial(user.id);

    return NextResponse.json({
      success: true,
      message: "Trial started! You now have 90 days of Pro access.",
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
