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
import { isEmailConfigured, type SendEmailInput } from "@/lib/email";
import { sendMail } from "@/lib/mail-log/deliver";
import { trustedOrigins } from "@/lib/trusted-origins";
import { composeMail } from "@/lib/mail-templates/compose";
import { recipientMailLocale, requestLocaleTags } from "@/lib/mail-templates/recipient-locale";
import type { TemplateDb } from "@/lib/mail-templates/store";
import { db, mongoClient } from "./app/db";
import { cfRequestProps, dbBackend, getD1, workerWaitUntil } from "./lib/d1";
import { securityPlugin } from "./lib/security/auth-plugin";
import type { ThrottleDb } from "./lib/security/throttle";
import { authCookieOptions, passwordAuthEnabled, runtimeNodeEnv } from "./lib/auth-env";
import { PASSKEY_RP_NAME, passkeyRelyingParty } from "./lib/passkey";
import { settleUserSponsorships, type D1WithBatch } from "./lib/payments/sponsors-store";
import { notifySignedOut } from "./lib/push-signed-out";
import { setEmailCanonical } from "./lib/canonical-email-d1";
import { recordSignupLocale } from "./lib/signup-locale-d1";
import { claimPregrants, type PregrantDb } from "./lib/referrals/pregrant";
import { boxBindingHook, boxProviderPlugin } from "./lib/box-oauth/provider";
import { apiTokenSignOutPlugin } from "./lib/api-token-signout";
import { notifyTokensRevoked } from "./lib/push-chat-tokens";
import type { D1Like } from "./lib/d1/types";
import type { AuditDb } from "./lib/security/audit-log";
import { signupBonusHooks, type SignupBonusDb } from "./lib/payments/signup-bonus-store";

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
async function sendSignInMail(kind: "otp" | "link", email: string, mail: SendEmailInput) {
  const domain = email.split("@")[1]?.toLowerCase() ?? "?";
  try {
    const { id } = await sendMail(mail);
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
 * A sign-in mail through the template store (docs/mail-templates.md): in the
 * account's language when the address has one, else the asking browser's; an
 * edited template that fails falls back to the built-in, so this never blocks.
 */
async function signInTemplate(
  email: string,
  ctx: { headers?: Headers | null } | null | undefined,
  id: "signin-code" | "signin-link",
  values: Record<string, string>,
) {
  const tdb = dbBackend() === "d1" ? (getD1() as unknown as TemplateDb) : null;
  const locale = await recipientMailLocale(tdb, { email }, ...requestLocaleTags(ctx?.headers));
  // `log` keeps no variable of a sign-in mail (lib/mail-log/vars.ts).
  const { subject, text, html, log } = await composeMail(tdb, id, locale, values);
  return { subject, text, html, log };
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
  // Sign-up bonus (docs/payments.md, "Sign-up bonus"): never fails the sign-in.
  const signupBonus = signupBonusHooks(() =>
    dbBackend() === "d1" ? (getD1() as unknown as SignupBonusDb) : null,
  );
  return {
    secret: process.env.AUTH_SECRET,
    baseURL:
      process.env.BETTER_AUTH_BASE_URL ?? process.env.BETTER_AUTH_URL ?? process.env.NEXTAUTH_URL,
    advanced: authCookieOptions(
      process.env.BETTER_AUTH_BASE_URL ?? process.env.BETTER_AUTH_URL ?? process.env.NEXTAUTH_URL,
    ),
    // Allow both www and non-www (the canonical domain is non-www).
    // Deployed origins plus a localhost QA origin derived from
    // BETTER_AUTH_BASE_URL, so qa:all can run on any port. Only localhost is
    // honoured — see lib/trusted-origins.ts.
    trustedOrigins: trustedOrigins(),

    // Profile edits go through /api/profile/** (lib/profile/), which validate
    // and then call this endpoint server-side. Over HTTP it would let a session
    // store any string as its name or image: a third-party URL among other
    // people's chat avatars, for one. disabledPaths closes HTTP only, not auth.api.
    disabledPaths: ["/update-user"],

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
    // before: a box's OAuth client belongs to one account (lib/box-oauth/provider.ts).
    hooks: { after: stripGrantedScopesHook, before: boxBindingHook },

    // A GitHub account just signed up or was linked: claim any GitHub
    // Sponsors sponsorship that was waiting for its id (docs/payments.md).
    // Never fails the sign-in; the next membership status read retries.
    databaseHooks: {
      // Sign-out (or any session deleted): the debug hub stops renewing the
      // owner's eval grants bound to that session at once (docs/monitoring.md, "Renewal").
      session: {
        // Pre-grants (lib/referrals/pregrant.ts): Pro days an admin gave this
        // address before the account existed are claimed at sign-in — only
        // when the account's email is verified. Never fails the sign-in.
        create: {
          after: async (session: { userId: string }) => {
            if (dbBackend() !== "d1") return;
            await claimPregrants(getD1() as unknown as PregrantDb, session.userId).catch((e) =>
              console.error("[pregrant] claim:", e),
            );
            // An account older than the sign-up bonus gets it once (the lazy backfill).
            await signupBonus.sessionCreated(session);
          },
        },
        delete: {
          after: async (session: { id: string }) => {
            await notifySignedOut(session.id);
          },
        },
      },
      // The canonical email (lib/canonical-email.ts), for the once-per-person
      // checks only — the trial, invite and gift rewards. Never fails the
      // sign-up; those checks fill it in themselves when it is missing.
      user: {
        create: {
          after: async (
            user: { id: string; email: string },
            ctx?: { headers?: Headers; request?: Request } | null,
          ) => {
            if (dbBackend() !== "d1") return;
            await setEmailCanonical(getD1(), user.id, user.email).catch((e) =>
              console.error("[email-canonical] create:", e),
            );
            // The browser language at sign-up, once (lib/signup-locale.ts): only
            // the normalised tag is kept, for mail sent in this person's name.
            const al = (ctx?.headers ?? ctx?.request?.headers)?.get("accept-language");
            await recordSignupLocale(getD1(), user.id, al).catch((e) =>
              console.error("[signup-locale] create:", e),
            );
            // The sign-up bonus: one of the UTC day's first N new accounts.
            await signupBonus.userCreated(user);
          },
        },
        update: {
          after: async (user: { id: string; email?: string | null; emailVerified?: boolean }) => {
            if (dbBackend() !== "d1" || !user.email) return;
            await setEmailCanonical(getD1(), user.id, user.email).catch((e) =>
              console.error("[email-canonical] update:", e),
            );
            // An address verified after sign-up claims its pre-grants now.
            if (user.emailVerified)
              await claimPregrants(getD1() as unknown as PregrantDb, user.id).catch((e) =>
                console.error("[pregrant] claim:", e),
              );
          },
        },
      },
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
      // my-<hash> boxes sign in through lianki.com: dark, its routes answer only
      // with the flag on (app/api/auth/[...all]/route.ts, docs/box-oauth.md).
      ...(dbBackend() === "d1" ? [boxProviderPlugin()] : []),
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
                  ...(await signInTemplate(email, ctx, "signin-code", { code: otp })),
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
                  ...(await signInTemplate(email, ctx, "signin-link", { url })),
                });
              },
            }),
          ]
        : []),
      // Sign in with a passkey (Touch ID, Windows Hello, a phone's screen lock),
      // added from the profile page or right after an email sign-in. Always on:
      // unlike mail it needs no provider. Table: db/migrations/0011_passkey.sql.
      passkeyPlugin(),
      // Sign-in lockout, code-send limits and the new-device login notice
      // (docs/security-measures.md). D1 only.
      securityPlugin({
        getDb: () => (dbBackend() === "d1" ? (getD1() as unknown as ThrottleDb) : null),
        getCf: cfRequestProps,
        waitUntil: (p) => {
          if (!workerWaitUntil(p)) void p;
        },
      }),
      // A sign-out everywhere (or the account deleted) revokes every API token of the account.
      apiTokenSignOutPlugin({
        getDb: () => (dbBackend() === "d1" ? (getD1() as unknown as D1Like & AuditDb) : null),
        revoked: (r) => notifyTokensRevoked(r),
      }),
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
