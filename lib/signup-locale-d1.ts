/**
 * `user.signupLocale` on D1 (db/migrations/0062_user_signup_locale.sql; rules in
 * lib/signup-locale.ts). Written once, by the user.create hook: the guard on
 * NULL means a later call never overwrites it.
 */
import type { D1Like } from "@/lib/d1/types";
import { signupLocaleFrom } from "@/lib/signup-locale";

/** Keep the best supported tag of the sign-up request's Accept-Language; no header, no write. */
export async function recordSignupLocale(
  d1: D1Like,
  userId: string,
  acceptLanguage: string | null | undefined,
): Promise<string | null> {
  const tag = signupLocaleFrom(acceptLanguage);
  if (!tag) return null;
  await d1
    .prepare("UPDATE user SET signupLocale = ?1 WHERE id = ?2 AND signupLocale IS NULL")
    .bind(tag, userId)
    .run();
  return tag;
}
