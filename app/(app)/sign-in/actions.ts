"use server";
import { auth } from "@/auth";
import { verifyTurnstileToken } from "@/lib/turnstile";
import { headers } from "next/headers";

export type MagicLinkResult = { success: true } | { success: false; error: string };

export async function sendMagicLinkAction(
  email: string,
  turnstileToken: string,
): Promise<MagicLinkResult> {
  const ok = await verifyTurnstileToken(turnstileToken);
  if (!ok) return { success: false, error: "CAPTCHA verification failed" };

  try {
    await auth.api.signInMagicLink({
      body: { email, callbackURL: "/home" },
      headers: await headers(),
    });
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to send magic link";
    return { success: false, error: message };
  }
}

/** Email a 6-digit sign-in code, after the human check. */
export async function sendSignInCodeAction(
  email: string,
  turnstileToken: string,
): Promise<MagicLinkResult> {
  const ok = await verifyTurnstileToken(turnstileToken);
  if (!ok) return { success: false, error: "captcha" };
  try {
    await auth.api.sendVerificationOTP({
      body: { email, type: "sign-in" },
      headers: await headers(),
    });
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to send the code";
    return { success: false, error: message };
  }
}
