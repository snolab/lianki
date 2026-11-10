import { logSanitizedError } from "@/lib/safeError";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { headers } from "next/headers";
import { startTrial, getUserMembership } from "@/lib/membership";

export async function POST() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "login-required" }, { status: 401 });
  }

  try {
    const user = session.user;
    const membership = await getUserMembership(user.id);

    // Check if user already has or had a trial
    if (membership.trialEndsAt) {
      return NextResponse.json({ error: "trial-used" }, { status: 400 });
    }

    // Check if user already has pro
    if (membership.tier === "pro") {
      return NextResponse.json({ error: "already-pro" }, { status: 400 });
    }

    await startTrial(user.id);

    return NextResponse.json({
      success: true,
      message: "Trial started! You now have 90 days of Pro access.",
    });
  } catch (error) {
    logSanitizedError("membership.start-trial", error);
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
