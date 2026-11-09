import { cache } from "react";
import { cookies, headers } from "next/headers";
import { LOCALE_HEADER, PARTNER_FRAME_HEADER, resolveLocale } from "@/lib/app-locale";
import {
  LOCALE_SRC_COOKIE,
  LOCALE_SRC_HEADER,
  needsAccountLocale,
  withAccountLocale,
} from "@/lib/account-locale";

export type AppLocaleState = {
  locale: string;
  /** Set when the account's language was read on this request: what the browser should remember. */
  adopt: { locale: string | null } | null;
};

/**
 * The app page's locale (lib/account-locale.ts): the middleware's pick, with
 * the signed-in account's language put first on a device that has not
 * adopted it yet. One D1 read per device, cached for the request.
 */
export const appLocaleState = cache(async (): Promise<AppLocaleState> => {
  const h = await headers();
  const locale = resolveLocale(h.get(LOCALE_HEADER));
  // Framed by any site (/embed/partner): its cookies are never ours to write.
  if (h.get(PARTNER_FRAME_HEADER) === "1") return { locale, adopt: null };
  const source = h.get(LOCALE_SRC_HEADER);
  const marker = (await cookies()).get(LOCALE_SRC_COOKIE)?.value;
  if (!needsAccountLocale({ source, marker, signedIn: true })) return { locale, adopt: null };
  try {
    const { dbBackend, getD1 } = await import("@/lib/d1");
    if (dbBackend() !== "d1") return { locale, adopt: null };
    const { authUserOrNull } = await import("@/app/signInEmail");
    const user = await authUserOrNull();
    if (!user?.id) return { locale, adopt: null };
    const { readAccountUiLocale } = await import("@/lib/account-locale-d1");
    return withAccountLocale(locale, await readAccountUiLocale(getD1() as never, user.id));
  } catch {
    return { locale, adopt: null };
  }
});

export async function appLocale(): Promise<string> {
  return (await appLocaleState()).locale;
}
