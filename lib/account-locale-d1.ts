/**
 * The account's UI language from D1 (lib/account-locale.ts): `ui.locale` from
 * user_prefs, else `user.signupLocale`. Each read fails on its own to null
 * (a missing column or table must never break a page), so the worst case is
 * the cookie / Accept-Language chain.
 */
import type { D1Like } from "@/lib/d1/types";
import { accountUiLocale, prefString } from "@/lib/account-locale";

export async function readAccountUiLocale(db: D1Like, userId: string): Promise<string | null> {
  // async, so a prepare that throws at once (no such column) is caught too
  const read = async <T>(sql: string) => db.prepare(sql).bind(userId).first<T>();
  const [pref, user] = await Promise.all([
    read<{ value: string }>(
      "SELECT value FROM user_prefs WHERE user_id = ?1 AND key = 'ui.locale'",
    ).catch(() => null),
    read<{ signupLocale: string | null }>("SELECT signupLocale FROM user WHERE id = ?1").catch(
      () => null,
    ),
  ]);
  return accountUiLocale({
    accountLocale: prefString(pref?.value),
    signupLocale: user?.signupLocale,
  });
}
