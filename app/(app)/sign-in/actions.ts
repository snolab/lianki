"use server";
import { auth } from "@/auth";
import { verifyTurnstileToken } from "@/lib/turnstile";
import { signInErrorFrom, type SignInError } from "@/lib/sign-in-errors";
import { headers } from "next/headers";

/** A failure is a key from lib/sign-in-errors.ts, never the server's own text. */
export type MagicLinkResult = { success: true } | { success: false; error: SignInError };

export async function sendMagicLinkAction(
  email: string,
  turnstileToken: string,
): Promise<MagicLinkResult> {
  const ok = await verifyTurnstileToken(turnstileToken);
  if (!ok) return { success: false, error: { key: "captcha" } };

  try {
    await auth.api.signInMagicLink({
      body: { email, callbackURL: "/home" },
      headers: await headers(),
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: signInErrorFrom(err, "sendFailed") };
  }
}

/** Email a 6-digit sign-in code, after the human check. */
export async function sendSignInCodeAction(
  email: string,
  turnstileToken: string,
): Promise<MagicLinkResult> {
  const ok = await verifyTurnstileToken(turnstileToken);
  if (!ok) return { success: false, error: { key: "captcha" } };
  try {
    await auth.api.sendVerificationOTP({
      body: { email, type: "sign-in" },
      headers: await headers(),
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: signInErrorFrom(err, "sendFailed") };
  }
}
