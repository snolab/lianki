/**
 * Sign-in errors as keys, never raw server text (app/(app)/sign-in).
 *
 * The page shows only strings from the `sign-in-errors` dictionary
 * (app/(app)/sign-in/errors.content.ts). Whatever the server or better-auth
 * says is mapped to one of these keys here; an unknown error falls back to the
 * key the caller names for that step.
 *
 * A refused attempt (429) carries the guard's wait (`retryAfterS`, set by
 * lib/security/auth-plugin.ts from the same verdict as its Retry-After
 * header). The lock is per address and per IP, kept whether or not an account
 * exists for the address, so "locked for N min" tells nothing the guard did
 * not already decide.
 */

export type SignInErrorKey =
  | "captcha"
  | "locked"
  | "tooMany"
  | "wrongCode"
  | "sendFailed"
  | "authFailed"
  | "signInFailed";

export type SignInError = { key: SignInErrorKey; retryAfterS?: number };

/** The guard's 429 body code (auth-plugin.ts). */
export const TOO_MANY_ATTEMPTS = "TOO_MANY_ATTEMPTS";

type Shape = {
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  retryAfterS?: unknown;
  body?: { code?: unknown; retryAfterS?: unknown } | null;
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Seconds left on a lock from an error object (client error or server APIError), or undefined. */
function retryAfterFrom(e: Shape): number | undefined {
  const s = num(e.retryAfterS) ?? num(e.body?.retryAfterS);
  return s !== undefined && s > 0 ? s : undefined;
}

function isTooMany(e: Shape): boolean {
  return (
    num(e.status) === 429 ||
    num(e.statusCode) === 429 ||
    e.status === "TOO_MANY_REQUESTS" ||
    e.code === TOO_MANY_ATTEMPTS ||
    e.body?.code === TOO_MANY_ATTEMPTS
  );
}

/**
 * Any error (better-auth client `result.error`, a thrown APIError, anything
 * else) → a known key. A 429 becomes `locked` with the minutes left when the
 * guard said how long, else `tooMany`; everything else is `fallback`.
 */
export function signInErrorFrom(err: unknown, fallback: SignInErrorKey): SignInError {
  if (err && typeof err === "object") {
    const e = err as Shape;
    if (isTooMany(e)) {
      const retryAfterS = retryAfterFrom(e);
      return retryAfterS ? { key: "locked", retryAfterS } : { key: "tooMany" };
    }
  }
  return { key: fallback };
}

/** Whole minutes to show for a wait: rounded up, at least 1. */
export function lockMinutes(retryAfterS: number | undefined): number {
  if (!retryAfterS || !Number.isFinite(retryAfterS) || retryAfterS <= 0) return 1;
  return Math.max(1, Math.ceil(retryAfterS / 60));
}

/** The text for an error, from the page's dictionary values. `{n}` = minutes. */
export function signInErrorText(err: SignInError, text: Record<SignInErrorKey, string>): string {
  const s = text[err.key];
  return err.key === "locked" ? s.replace("{n}", String(lockMinutes(err.retryAfterS))) : s;
}
