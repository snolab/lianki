import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { headers } from "next/headers";
import DIE from "phpdie";
import { mongoClient } from "@/app/db";

export const auth = betterAuth({
  database: mongodbAdapter(mongoClient.db()),
  secret: process.env.BETTER_AUTH_SECRET || process.env.AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL || process.env.NEXTAUTH_URL,
  emailAndPassword: {
    enabled: true,
  },
  socialProviders: {
    github: {
      clientId: process.env.AUTH_GITHUB_ID || "",
      clientSecret: process.env.AUTH_GITHUB_SECRET || "",
      enabled: !!process.env.AUTH_GITHUB_SECRET,
    },
    google: {
      clientId: process.env.AUTH_GOOGLE_ID || "",
      clientSecret: process.env.AUTH_GOOGLE_SECRET || "",
      enabled: !!process.env.AUTH_GOOGLE_SECRET,
    },
  },
  emailVerification: {
    sendOnSignUp: !!process.env.EMAIL_SERVER,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      if (!process.env.EMAIL_SERVER) return;

      const nodemailer = await import("nodemailer");
      const transporter = nodemailer.createTransport(process.env.EMAIL_SERVER);

      await transporter.sendMail({
        from: process.env.EMAIL_FROM,
        to: user.email,
        subject: "Verify your email",
        html: `<p>Click <a href="${url}">here</a> to verify your email.</p>`,
      });
    },
  },
  trustedOrigins: process.env.NEXTAUTH_URL ? [process.env.NEXTAUTH_URL] : [],
});

export type Session = typeof auth.$Infer.Session;

export async function getSession() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });
  return session;
}

export async function authUser() {
  const session = await getSession();
  return session?.user || DIE("User not authenticated");
}

export async function authEmail() {
  const user = await authUser();
  return user.email || DIE("User missing email");
}
