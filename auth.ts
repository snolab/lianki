import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { kyselyAdapter } from "@better-auth/kysely-adapter";
import { nextCookies } from "better-auth/next-js";
import { emailOTP, magicLink } from "better-auth/plugins";
import { stripGrantedScopesHook } from "@/lib/google-auth-url";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import { isEmailConfigured, sendEmail } from "@/lib/email";
import { trustedOrigins } from "@/lib/trusted-origins";
import { mailLocale, signInMail } from "@/lib/sign-in-mail";
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

/**
 * Dev-only email+password sign-in/up, so the full flow can be QA'd locally
 * without OAuth, SMTP or Turnstile. Never in production; the sign-in page asks
 * this too, so it only offers a password where one can work.
 */
export function passwordAuthEnabled(): boolean {
  return runtimeNodeEnv() !== "production" && process.env.DEV_EMAIL_PASSWORD_AUTH === "1";
}

/**
 * Send a sign-in mail and leave one log line either way, for Workers Logs:
 * the kind, the recipient's domain (never the full address), and Resend's
 * message id or the error — enough to trace "QQ Mail can't sign in".
 */
async function sendSignInMail(
  kind: "otp" | "link",
  email: string,
  mail: Parameters<typeof sendEmail>[0],
) {
  const domain = email.split("@")[1]?.toLowerCase() ?? "?";
  try {
    const { id } = await sendEmail(mail);
    console.log(JSON.stringify({ event: "signin.mail.sent", kind, domain, id }));
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "signin.mail.failed",
        kind,
        domain,
        error: String(err).slice(0, 300),
      }),
    );
    throw err;
  }
}

/** Backend-agnostic better-auth options (everything except `database`). */
function baseOptions() {
  return {
    secret: process.env.AUTH_SECRET,
    baseURL:
      process.env.BETTER_AUTH_BASE_URL ?? process.env.BETTER_AUTH_URL ?? process.env.NEXTAUTH_URL,
    // Allow both www and non-www (the canonical domain is non-www).
    // Deployed origins plus a localhost QA origin derived from
    // BETTER_AUTH_BASE_URL, so qa:all can run on any port. Only localhost is
    // honoured — see lib/trusted-origins.ts.
    trustedOrigins: trustedOrigins(),

    // Production stays passwordless (magic link + OAuth); see passwordAuthEnabled.
    emailAndPassword: { enabled: passwordAuthEnabled() },

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

    // The Google URL must not ask for previously granted scopes — see
    // lib/google-auth-url.ts.
    hooks: { after: stripGrantedScopesHook },

    plugins: [
      // Gated on configuration, as the SMTP version was: with no provider the
      // plugin is absent and the sign-in form offers only OAuth, rather than
      // accepting an address and silently dropping the mail.
      ...(isEmailConfigured()
        ? [
            // The sign-in page's path: a 6-digit code typed on the same page.
            // Unlike a link, it works when the mail is opened on another device
            // or inside an app's built-in browser (WeChat, QQ Mail), and an
            // unknown address simply gets an account (sign-in = sign-up).
            emailOTP({
              otpLength: 6,
              expiresIn: 15 * 60,
              allowedAttempts: 5,
              sendVerificationOTP: async ({ email, otp }, ctx) => {
                await sendSignInMail("otp", email, {
                  to: email,
                  ...signInMail(mailLocale(ctx), { otp }),
                });
              },
            }),
            magicLink({
              // 15 minutes, not the 5-minute default: mail to some providers
              // can take longer than that to arrive.
              expiresIn: 15 * 60,
              sendMagicLink: async ({ email, url }, ctx) => {
                await sendSignInMail("link", email, {
                  to: email,
                  ...signInMail(mailLocale(ctx), { url }),
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
