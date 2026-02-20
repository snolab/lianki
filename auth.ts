import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { nextCookies } from "better-auth/next-js";
import { magicLink } from "better-auth/plugins";
import nodemailer from "nodemailer";
import { db, mongoClient } from "./app/db";

export const auth = betterAuth({
  secret: process.env.AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL ?? process.env.NEXTAUTH_URL,

  database: mongodbAdapter(db, { client: mongoClient }),

  socialProviders: {
    ...(process.env.AUTH_GITHUB_SECRET
      ? {
          github: {
            clientId: process.env.AUTH_GITHUB_ID as string,
            clientSecret: process.env.AUTH_GITHUB_SECRET as string,
          },
        }
      : {}),
    ...(process.env.AUTH_GOOGLE_SECRET
      ? {
          google: {
            clientId: process.env.AUTH_GOOGLE_ID as string,
            clientSecret: process.env.AUTH_GOOGLE_SECRET as string,
          },
        }
      : {}),
  },

  plugins: [
    ...(process.env.EMAIL_SERVER
      ? [
          magicLink({
            sendMagicLink: async ({ email, url }) => {
              const transport = nodemailer.createTransport(process.env.EMAIL_SERVER!);
              await transport.sendMail({
                from: process.env.EMAIL_FROM,
                to: email,
                subject: "Sign in to Lianki",
                text: `Sign in to Lianki: ${url}`,
                html: `<a href="${url}">Sign in to Lianki</a>`,
              });
            },
          }),
        ]
      : []),
    nextCookies(), // must be last — handles Set-Cookie in server actions
  ],
});
