"use client";

import { useEffect } from "react";
import { adoptCookieLines } from "@/lib/account-locale";

/**
 * The server read this account's language for the page (lib/account-locale.ts):
 * remember it on this device, so the next page needs no read. Writes the
 * `lang` / `NEXT_LOCALE` cookies and the `acct` marker; never `lk:ui-locale`,
 * which means "picked by hand" and would be uploaded. Renders nothing.
 */
export function AccountLocaleAdopt({ locale }: { locale: string | null }) {
  useEffect(() => {
    for (const line of adoptCookieLines(locale)) {
      try {
        document.cookie = line;
      } catch {}
    }
  }, [locale]);
  return null;
}
