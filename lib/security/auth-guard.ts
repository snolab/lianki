/**
 * Sign-in brute-force limits, independent of better-auth so they can be unit
 * tested; lib/security/auth-plugin.ts wires them into the auth endpoints.
 *
 * Lianki has no password login in production (OAuth, an emailed 6-digit code,
 * passkeys). What can be guessed is the code, so:
 *
 * - each code dies after 5 wrong tries (better-auth `allowedAttempts`);
 * - 10 failed sign-ins within 15 minutes lock that **account** for 30 minutes,
 *   and 10 from one **IP** lock that IP — for every code endpoint and for
 *   passkey verification (which has no account to key on before it succeeds);
 * - sending codes is limited to 5 per address and 20 per IP per 15 minutes.
 *
 * A successful sign-in clears the account's failures. The dev-only password
 * path (`/sign-in/email`, off in production — lib/auth-env.ts) is not counted,
 * so the QA suites can sign up as many users as they like from one address.
 */
import {
  CODE_SENDS_PER_ACCOUNT,
  CODE_SENDS_PER_IP,
  SIGN_IN_FAILURES,
  accountKey,
  hit,
  ipKey,
  lockedFor,
  reset,
  type ThrottleDb,
} from "./throttle";

/** Endpoints that check a code: a wrong one is a failed sign-in. */
export const CODE_CHECK_PATHS = new Set([
  "/sign-in/email-otp",
  "/email-otp/verify-email",
  "/email-otp/check-verification-otp",
  "/email-otp/reset-password",
  "/email-otp/change-email",
]);
/** Endpoints that check a credential with no account known up front: per IP only. */
export const IP_ONLY_CHECK_PATHS = new Set(["/passkey/verify-authentication"]);
/** Endpoints that send a sign-in code or link. */
export const SEND_PATHS = new Set([
  "/email-otp/send-verification-otp",
  "/sign-in/magic-link",
  "/email-otp/request-password-reset",
  "/forget-password/email-otp",
  "/email-otp/request-email-change",
]);

/** Paths that start a session: a `newSession` on one of these is a sign-in. */
export function isSignInPath(path: string): boolean {
  return (
    path.startsWith("/sign-in/") ||
    path.startsWith("/sign-up/") ||
    path.startsWith("/callback/") ||
    path.startsWith("/oauth2/callback/") ||
    path === "/magic-link/verify" ||
    path === "/email-otp/verify-email" ||
    path === "/passkey/verify-authentication"
  );
}

export const FAIL = "fail";
export const SEND = "send";

const usableIp = (ip: string) => ip && ip !== "unknown";
const usableEmail = (e: unknown): e is string => typeof e === "string" && e.includes("@");

export type Verdict = { ok: true } | { ok: false; retryAfterMs: number };

/** Before an attempt: refuse it if the account or IP is locked or over its send limit. */
export async function checkAttempt(
  db: ThrottleDb,
  a: { path: string; email?: unknown; ip: string; now?: number },
): Promise<Verdict> {
  const now = a.now ?? Date.now();
  const checks = CODE_CHECK_PATHS.has(a.path) || IP_ONLY_CHECK_PATHS.has(a.path);
  if (checks) {
    const waits: number[] = [];
    if (usableIp(a.ip)) waits.push(await lockedFor(db, ipKey(FAIL, a.ip), now));
    if (CODE_CHECK_PATHS.has(a.path) && usableEmail(a.email))
      waits.push(await lockedFor(db, await accountKey(FAIL, a.email), now));
    const wait = Math.max(0, ...waits);
    return wait > 0 ? { ok: false, retryAfterMs: wait } : { ok: true };
  }
  if (SEND_PATHS.has(a.path)) {
    const results = [];
    if (usableEmail(a.email)) {
      // A locked account gets no new codes either.
      const locked = await lockedFor(db, await accountKey(FAIL, a.email), now);
      if (locked > 0) return { ok: false, retryAfterMs: locked };
      results.push(await hit(db, await accountKey(SEND, a.email), CODE_SENDS_PER_ACCOUNT, now));
    }
    if (usableIp(a.ip)) results.push(await hit(db, ipKey(SEND, a.ip), CODE_SENDS_PER_IP, now));
    const refused = results.filter((r) => !r.allowed);
    return refused.length
      ? { ok: false, retryAfterMs: Math.max(...refused.map((r) => r.retryAfterMs)) }
      : { ok: true };
  }
  return { ok: true };
}

/** A 4xx other than 429 from a checking endpoint: the credential was wrong. */
export function isFailureStatus(status: number | undefined): boolean {
  return status !== undefined && status >= 400 && status < 500 && status !== 429;
}

/** After an attempt: count a failure, or clear the account's failures on success. */
export async function recordAttempt(
  db: ThrottleDb,
  a: { path: string; email?: unknown; ip: string; failed: boolean; now?: number },
): Promise<void> {
  const now = a.now ?? Date.now();
  const code = CODE_CHECK_PATHS.has(a.path);
  if (!code && !IP_ONLY_CHECK_PATHS.has(a.path)) return;
  if (a.failed) {
    if (usableIp(a.ip)) await hit(db, ipKey(FAIL, a.ip), SIGN_IN_FAILURES, now);
    if (code && usableEmail(a.email))
      await hit(db, await accountKey(FAIL, a.email), SIGN_IN_FAILURES, now);
  } else if (code && usableEmail(a.email)) {
    await reset(db, await accountKey(FAIL, a.email));
  }
}
