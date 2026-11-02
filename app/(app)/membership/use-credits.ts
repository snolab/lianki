"use client";

import { useIntlayer, useLocale } from "next-intlayer";
import { formatCredits, formatSignedCredits, type CreditForms } from "@/lib/payments/credit-units";

/** Yen — only where real money is charged (a top-up's price), never the balance. */
export const yen = (n: number) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency: "JPY" }).format(n);

/**
 * Wallet amounts in credits for the current locale: `credits(1200)` →
 * "1,200 credits", `signed(-600)` → "−600 credits", `topup(600)` →
 * "¥600 → 600 credits" (what is paid and what lands in the wallet).
 */
export function useCredits() {
  const { amount } = useIntlayer("credit-units");
  const { locale } = useLocale();
  const forms: CreditForms = {
    zero: amount.zero.value,
    one: amount.one.value,
    two: amount.two.value,
    few: amount.few.value,
    many: amount.many.value,
    other: amount.other.value,
  };
  const credits = (n: number) => formatCredits(n, locale, forms);
  const signed = (n: number) => formatSignedCredits(n, locale, forms);
  const topup = (n: number) => `${yen(n)} → ${credits(n)}`;
  return { credits, signed, topup };
}
