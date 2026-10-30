/**
 * better-auth plugin wiring lib/security into every auth endpoint:
 *
 * - before a code check / passkey verification / code send: refuse with 429
 *   while the account or IP is locked or over its limit (auth-guard.ts);
 * - after: count a failure, or clear the account's failures;
 * - after a sign-in from a browser the account has not used: email the
 *   account a login notice (login-notice.ts).
 *
 * Only on D1 (production); on the frozen Mongo backend `getDb` gives null and
 * the plugin does nothing. Neither half can fail a sign-in: their own errors
 * are logged and swallowed — only a deliberate 429 is ever returned.
 */
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { isEmailConfigured, sendEmail } from "@/lib/email";
import { mailLocale } from "@/lib/sign-in-mail";
import {
  CODE_CHECK_PATHS,
  IP_ONLY_CHECK_PATHS,
  SEND_PATHS,
  checkAttempt,
  isFailureStatus,
  isSignInPath,
  recordAttempt,
} from "./auth-guard";
import {
  DEVICE_COOKIE,
  DEVICE_COOKIE_MAX_AGE_S,
  approximateLocation,
  loginNoticeMail,
  recordSignIn,
} from "./login-notice";
import { clientIp, type ThrottleDb } from "./throttle";

export interface SecurityPluginEnv {
  getDb: () => ThrottleDb | null;
  /** Cloudflare's request.cf, for the notice's location. */
  getCf?: () => { city?: unknown; region?: unknown; country?: unknown } | null | undefined;
  /** Keep the notice mail alive after the response (Workers `ctx.waitUntil`). */
  waitUntil?: (p: Promise<unknown>) => void;
}

const guarded = (path: string) =>
  CODE_CHECK_PATHS.has(path) || IP_ONLY_CHECK_PATHS.has(path) || SEND_PATHS.has(path);

function statusOf(returned: unknown): number | undefined {
  if (!returned || typeof returned !== "object") return undefined;
  const r = returned as { statusCode?: unknown; status?: unknown };
  if (typeof r.statusCode === "number") return r.statusCode;
  return undefined;
}

export function securityPlugin(env: SecurityPluginEnv): BetterAuthPlugin {
  return {
    id: "lianki-security",
    hooks: {
      before: [
        {
          matcher: (ctx) => guarded(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const db = env.getDb();
            if (!db) return;
            let verdict;
            try {
              verdict = await checkAttempt(db, {
                path: ctx.path,
                email: (ctx.body as { email?: unknown } | undefined)?.email,
                ip: clientIp(ctx.headers),
              });
            } catch (e) {
              console.error("[security] check:", e);
              return;
            }
            if (!verdict.ok) {
              console.log(JSON.stringify({ event: "auth.throttled", path: ctx.path }));
              throw new APIError(
                "TOO_MANY_REQUESTS",
                {
                  message: "Too many attempts. Please try again later.",
                  code: "TOO_MANY_ATTEMPTS",
                },
                { "Retry-After": String(Math.ceil(verdict.retryAfterMs / 1000)) },
              );
            }
          }),
        },
      ],
      after: [
        {
          matcher: () => true,
          handler: createAuthMiddleware(async (ctx) => {
            const db = env.getDb();
            if (!db) return;
            const path = ctx.path;
            const status = statusOf(ctx.context.returned);
            const newSession = ctx.context.newSession;

            if (CODE_CHECK_PATHS.has(path) || IP_ONLY_CHECK_PATHS.has(path)) {
              await recordAttempt(db, {
                path,
                email: (ctx.body as { email?: unknown } | undefined)?.email,
                ip: clientIp(ctx.headers),
                failed: !newSession && isFailureStatus(status),
              }).catch((e) => console.error("[security] record:", e));
            }

            if (!newSession || !isSignInPath(path)) return;
            const { user } = newSession;
            const userAgent = ctx.headers?.get("user-agent");
            let rec;
            try {
              rec = await recordSignIn(db, {
                userId: user.id,
                userCreatedAt: user.createdAt,
                deviceCookie: ctx.getCookie(DEVICE_COOKIE),
                userAgent,
              });
            } catch (e) {
              console.error("[security] device:", e);
              return;
            }
            ctx.setCookie(DEVICE_COOKIE, rec.deviceId, {
              httpOnly: true,
              secure: ctx.context.authCookies.sessionToken.attributes.secure,
              sameSite: "lax",
              path: "/",
              maxAge: DEVICE_COOKIE_MAX_AGE_S,
            });
            if (!rec.notify || !user.email || !isEmailConfigured()) return;

            let cf;
            try {
              cf = env.getCf?.();
            } catch {}
            const mail = loginNoticeMail(mailLocale(ctx), {
              when: new Date(),
              location: approximateLocation(cf, ctx.headers),
              userAgent,
            });
            const send = sendEmail({ to: user.email, ...mail })
              .then(({ id }) => console.log(JSON.stringify({ event: "login.notice.sent", id })))
              .catch((e) =>
                console.error(
                  JSON.stringify({ event: "login.notice.failed", error: String(e).slice(0, 300) }),
                ),
              );
            if (env.waitUntil) env.waitUntil(send);
            else await send;
          }),
        },
      ],
    },
  };
}
