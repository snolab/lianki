import { betterAuth } from "better-auth";
import { kyselyAdapter } from "@better-auth/kysely-adapter";
import { magicLink } from "better-auth/plugins";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";

export type AuthEnv = {
  DB: D1Database;
  AUTH_SECRET?: string;
  AUTH_GOOGLE_ID?: string;
  AUTH_GOOGLE_SECRET?: string;
  AUTH_GITHUB_ID?: string;
  AUTH_GITHUB_SECRET?: string;
  EMAIL_FROM?: string;
  RESEND_API_KEY?: string;
  BETTER_AUTH_URL?: string;
};

// Workers-clean better-auth: no better-auth/next-js cookies plugin, no MongoDB,
// no nodemailer SMTP (doesn't run on Workers). Reuses the already-migrated D1
// user/session/account/verification tables via the Kysely D1 dialect. Magic-link
// email is sent over HTTP (Resend) when configured, else logged (dev).
function build(env: AuthEnv) {
  const kysely = new Kysely<Record<string, never>>({
    dialect: new D1Dialect({ database: env.DB as never }),
  });
  return betterAuth({
    secret: env.AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL, // else derived from the request origin
    trustedOrigins: [
      "https://lianki.com",
      "https://www.lianki.com",
      "https://lianki-cf.snomiao.workers.dev",
      "http://localhost:5173",
    ],
    database: kyselyAdapter(kysely, { type: "sqlite" }),
    socialProviders: {
      ...(env.AUTH_GITHUB_SECRET
        ? { github: { clientId: env.AUTH_GITHUB_ID!, clientSecret: env.AUTH_GITHUB_SECRET } }
        : {}),
      ...(env.AUTH_GOOGLE_SECRET
        ? { google: { clientId: env.AUTH_GOOGLE_ID!, clientSecret: env.AUTH_GOOGLE_SECRET } }
        : {}),
    },
    plugins: [
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          if (env.RESEND_API_KEY) {
            await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: {
                authorization: `Bearer ${env.RESEND_API_KEY}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                from: env.EMAIL_FROM ?? "Lianki <noreply@lianki.com>",
                to: email,
                subject: "Sign in to Lianki",
                html: `<a href="${url}">Sign in to Lianki</a>`,
              }),
            });
          } else {
            console.log(`[auth] magic link for ${email}: ${url}`);
          }
        },
      }),
    ],
  });
}

// One instance per Worker isolate (the DB binding is stable per isolate).
let cached: ReturnType<typeof build> | undefined;
export function getAuth(env: AuthEnv) {
  if (!cached) cached = build(env);
  return cached;
}
