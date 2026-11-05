import { describe, expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { emailOTP } from "better-auth/plugins/email-otp";
import { magicLink } from "better-auth/plugins/magic-link";
import { canonicalEmail } from "@/lib/canonical-email";

/**
 * Sign-in keeps a plus address as given (lib/canonical-email.ts): the real
 * better-auth plugins, configured as auth-impl.ts does, make it its own account
 * beside the plain address. Nothing is mailed; the hooks below catch the codes.
 */
function harness() {
  const otps = new Map<string, string>();
  const links = new Map<string, string>();
  const auth = betterAuth({
    secret: "a-test-secret-a-test-secret-a-test-secret",
    baseURL: "http://localhost:3000",
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: 15 * 60,
        allowedAttempts: 5,
        sendVerificationOTP: async ({ email, otp }) => void otps.set(email, otp),
      }),
      magicLink({
        expiresIn: 15 * 60,
        sendMagicLink: async ({ email, url }) => void links.set(email, url),
      }),
    ],
  });
  const headers = new Headers();
  const signInOtp = async (email: string) => {
    await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" }, headers });
    const otp = otps.get(email);
    if (!otp) throw new Error(`no code for ${email}`);
    return auth.api.signInEmailOTP({ body: { email, otp }, headers });
  };
  return { auth, links, headers, signInOtp };
}

const PLAIN = "owner@gmail.com";
const PLUS = "owner+admin@gmail.com";

describe("a plus address signs in as its own account", () => {
  test("the email code creates it, apart from the plain address", async () => {
    const { signInOtp } = harness();
    const plain = await signInOtp(PLAIN);
    const plus = await signInOtp(PLUS);
    expect(canonicalEmail(PLUS)).toBe(canonicalEmail(PLAIN));
    expect(plus.user.email).toBe(PLUS);
    expect(plus.user.id).not.toBe(plain.user.id);
    expect(plain.user.email).toBe(PLAIN);
    // Signing in again finds the same account.
    expect((await signInOtp(PLUS)).user.id).toBe(plus.user.id);
  });

  test("the magic link carries it through the URL unharmed", async () => {
    const { auth, links, headers } = harness();
    await auth.api.signInMagicLink({ body: { email: PLUS }, headers });
    const sent = links.get(PLUS);
    if (!sent) throw new Error("no link");
    const res = await auth.handler(new Request(sent, { redirect: "manual" }));
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location") ?? "").not.toContain("error");
    const ctx = await auth.$context;
    expect((await ctx.internalAdapter.findUserByEmail(PLUS))?.user.email).toBe(PLUS);
    expect(await ctx.internalAdapter.findUserByEmail(PLAIN)).toBeNull();
  });
});
