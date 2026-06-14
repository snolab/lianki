import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { kyselyAdapter } from "@better-auth/kysely-adapter";
import { nextCookies } from "better-auth/next-js";
import { magicLink } from "better-auth/plugins";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import nodemailer from "nodemailer";
import { db, mongoClient } from "./app/db";
import { dbBackend, getD1 } from "./lib/d1";

// Auth type derived from a representative instance so plugin endpoints
// (e.g. magicLink's signInMagicLink) stay visible to callers. Never called.
function buildMongoAuth() {
  return betterAuth({ ...baseOptions(), database: mongodbAdapter(db, { client: mongoClient }) });
}
type Auth = ReturnType<typeof buildMongoAuth>;

/**
 * Read NODE_ENV at runtime. The bundler (Turbopack/webpack DefinePlugin)
 * replaces the *literal* `process.env.NODE_ENV` with a string at build time; in
 * the production OpenNext build that bakes in "production" and dead-code-
 * eliminates the dev gate below, so a local `wrangler dev` could never re-enable
 * it via `.dev.vars`. A computed key defeats the static replacement, so the gate
 * reflects the actual runtime env. Prod stays safe: the deployed Worker has no
 * `.dev.vars`, so it still resolves "production" and the gate stays off.
 */
function runtimeNodeEnv(): string | undefined {
  // `globalThis.process` indirection: DefinePlugin only rewrites the literal
  // `process.env.NODE_ENV` member chain, not a dynamic key off globalThis.
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const key = ["NODE", "ENV"].join("_");
  return proc?.env?.[key];
}

/** Backend-agnostic better-auth options (everything except `database`). */
function baseOptions() {
  return {
    secret: process.env.AUTH_SECRET,
    baseURL:
      process.env.BETTER_AUTH_BASE_URL ?? process.env.BETTER_AUTH_URL ?? process.env.NEXTAUTH_URL,
    // Allow both www and non-www (the canonical domain is non-www).
    trustedOrigins: ["https://lianki.com", "https://www.lianki.com", "http://localhost:3000"],

    // Dev-only email+password sign-in/up so the full flow can be QA'd locally
    // without OAuth, SMTP, or Turnstile. Production stays passwordless (magic
    // link + OAuth): this is honored only outside production AND when explicitly
    // opted in via DEV_EMAIL_PASSWORD_AUTH=1, so it can never be enabled on the
    // deployed app. The sign-in UI already drives the password path.
    emailAndPassword: {
      enabled: runtimeNodeEnv() !== "production" && process.env.DEV_EMAIL_PASSWORD_AUTH === "1",
    },

    // Note: trialEndsAt / proEndsAt are managed out-of-band by lib/membership.ts
    // (direct collection / D1 writes), so they are intentionally not declared as
    // better-auth additionalFields. The D1 `user` table keeps them nullable.

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
  };
}

let mongoAuth: Auth | undefined;
let d1Auth: Auth | undefined;

/**
 * Resolve the better-auth instance for the active DB backend.
 *
 * D1 bindings are request-scoped, so the D1 instance is built lazily on first
 * use (the binding object is stable per Worker isolate, so memoising is safe).
 */
export function getAuth(): Auth {
  if (dbBackend() === "d1") {
    if (!d1Auth) {
      const kysely = new Kysely<Record<string, never>>({
        dialect: new D1Dialect({ database: getD1() as never }),
      });
      d1Auth = betterAuth({
        ...baseOptions(),
        database: kyselyAdapter(kysely, { type: "sqlite" }),
      }) as Auth;
    }
    return d1Auth;
  }
  if (!mongoAuth) {
    mongoAuth = buildMongoAuth();
  }
  return mongoAuth;
}

/**
 * Lazy proxy so existing `import { auth }` call sites keep working unchanged.
 * Every property access resolves through getAuth() at request time.
 */
export const auth: Auth = new Proxy({} as Auth, {
  get: (_target, prop) => Reflect.get(getAuth() as object, prop),
});
