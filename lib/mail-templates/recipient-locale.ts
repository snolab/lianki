/**
 * The recipient's mail language from D1 and the request (docs/mail-templates.md,
 * "Language"): the account's `ui.locale` → its `signupLocale` → the request's
 * language (only where the request comes from the recipient themselves, e.g.
 * asking for a sign-in code) → English. See locales.ts for the zh-Hant rule.
 *
 * Every read fails on its own to nothing (a missing column or table must never
 * stop a sign-in mail), so the worst case is the request's language or English.
 */
import { LOCALE_HEADER } from "@/lib/app-locale";
import { prefString } from "@/lib/account-locale";
import { signupLocaleFrom } from "@/lib/signup-locale";
import { pickMailLocale, type MailLocale } from "./locales";
import type { TemplateDb } from "./store";

/** The account's two language tags, by user id or by address; nulls when unknown. */
export async function accountLocaleTags(
  db: TemplateDb | null | undefined,
  who: { userId: string } | { email: string },
): Promise<[string | null, string | null]> {
  if (!db) return [null, null];
  const read = async <T>(sql: string, v: string) => db.prepare(sql).bind(v).first<T>();
  let userId: string | null = null;
  let signup: string | null = null;
  try {
    const row =
      "userId" in who
        ? await read<{ id: string; signupLocale: string | null }>(
            "SELECT id, signupLocale FROM user WHERE id = ?1",
            who.userId,
          )
        : await read<{ id: string; signupLocale: string | null }>(
            "SELECT id, signupLocale FROM user WHERE email = ?1",
            who.email.trim().toLowerCase(),
          );
    userId = row?.id ?? null;
    signup = row?.signupLocale ?? null;
  } catch {
    // signupLocale may not exist yet: try the id alone
    if ("userId" in who) userId = who.userId;
    else
      userId =
        (
          await read<{ id: string }>(
            "SELECT id FROM user WHERE email = ?1",
            who.email.trim().toLowerCase(),
          ).catch(() => null)
        )?.id ?? null;
  }
  if (!userId) return [null, signup];
  const pref = await read<{ value: string }>(
    "SELECT value FROM user_prefs WHERE user_id = ?1 AND key = 'ui.locale'",
    userId,
  ).catch(() => null);
  return [prefString(pref?.value), signup];
}

/** The request's own language tags: the app's locale header, then Accept-Language's best. */
export function requestLocaleTags(headers: Headers | null | undefined): (string | null)[] {
  if (!headers) return [];
  return [headers.get(LOCALE_HEADER), signupLocaleFrom(headers.get("accept-language"))];
}

/** account `ui.locale` → `signupLocale` → `extra` tags in order → en. */
export async function recipientMailLocale(
  db: TemplateDb | null | undefined,
  who: { userId: string } | { email: string },
  ...extra: (string | null | undefined)[]
): Promise<MailLocale> {
  const [ui, signup] = await accountLocaleTags(db, who);
  return pickMailLocale(ui, signup, ...extra);
}
