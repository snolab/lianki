import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { kyselyAdapter } from "@better-auth/kysely-adapter";
import { nextCookies } from "better-auth/next-js";
// Per-plugin subpaths, never the `better-auth/plugins` barrel: better-auth
// declares no `sideEffects`, so the barrel drags every plugin (organization,
// oidc-provider, mcp, admin, …) into each server chunk that imports auth —
// ~13 copies in the Worker bundle, all parsed on an isolate's first request.
import { emailOTP } from "better-auth/plugins/email-otp";
import { magicLink } from "better-auth/plugins/magic-link";
import { passkey } from "@better-auth/passkey";
import { stripGrantedScopesHook } from "@/lib/google-auth-url";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import { isEmailConfigured, sendEmail } from "@/lib/email";
import { trustedOrigins } from "@/lib/trusted-origins";
import { mailLocale, signInMail } from "@/lib/sign-in-mail";
import { db, mongoClient } from "./app/db";
import { dbBackend, getD1 } from "./lib/d1";
import { passwordAuthEnabled, runtimeNodeEnv } from "./lib/auth-env";
import { PASSKEY_RP_NAME, passkeyRelyingParty } from "./lib/passkey";
import { settleUserSponsorships, type D1WithBatch } from "./lib/payments/sponsors-store";

// The heavy half of auth: better-auth, its plugins, zod, kysely. Only ever
// reached through the dynamic import in ./auth.ts, so it is one shared async
// chunk instead of a copy inside every route that touches auth — see there.

// Auth type derived from a representative instance so plugin endpoints
// (e.g. magicLink's signInMagicLink) stay visible to callers. Never called.
function buildMongoAuth() {
  return betterAuth({ ...baseOptions(), database: mongodbAdapter(db, { client: mongoClient }) });
}
export type Auth = ReturnType<typeof buildMongoAuth>;

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

/**
 * Passkeys: the relying party is `lianki.com` in production and the exact
 * localhost origin in dev/QA — see lib/passkey.ts for why it is not left to the
 * plugin. Anything but an explicit dev/test NODE_ENV counts as production, so a
 * missing env can only ever pick the real domain.
 */
function passkeyPlugin() {
  const env = runtimeNodeEnv();
  const { rpID, origin } = passkeyRelyingParty(
    process.env.BETTER_AUTH_BASE_URL ?? process.env.BETTER_AUTH_URL ?? process.env.NEXTAUTH_URL,
    env !== "development" && env !== "test",
  );
  return passkey({ rpID, rpName: PASSKEY_RP_NAME, origin });
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

    // A GitHub account just signed up or was linked: claim any GitHub
    // Sponsors sponsorship that was waiting for its id (docs/payments.md).
    // Never fails the sign-in; the next membership status read retries.
    databaseHooks: {
      account: {
        create: {
          after: async (account: { providerId: string; userId: string }) => {
            if (account.providerId !== "github" || dbBackend() !== "d1") return;
            await settleUserSponsorships(getD1() as unknown as D1WithBatch, account.userId).catch(
              (e) => console.error("[sponsors] claim:", e),
            );
          },
        },
      },
    },

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
      // Sign in with a passkey (Touch ID, Windows Hello, a phone's screen lock),
      // added from the profile page or right after an email sign-in. Always on:
      // unlike mail it needs no provider. Table: db/migrations/0011_passkey.sql.
      passkeyPlugin(),
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
