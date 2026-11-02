/**
 * Showing a wallet amount in credits (owner, 2026-11-03: "余额用 credits 表示，
 * 不要用法币"). The ledger stores whole credits; one credit is what one yen
 * of top-up buys (`credit_ledger.amount`, lib/payments/credits.ts), so the
 * number shown is the stored amount itself — no conversion. Fiat appears only
 * where real money is charged (a top-up's price), never for the balance.
 */

/** One phrase per CLDR plural category, `{n}` standing for the number. */
export type CreditForms = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };

/** "1,200 credits", "1 credit", "1 200 кредитов" — the plural form for `locale`. */
export function formatCredits(n: number, locale: string, forms: CreditForms): string {
  let category: Intl.LDMLPluralRule = "other";
  let number = String(n);
  try {
    category = new Intl.PluralRules(locale).select(n);
    number = new Intl.NumberFormat(locale).format(n);
  } catch {
    // An unknown locale tag: keep "other" and the plain number.
  }
  return (forms[category] ?? forms.other).replace("{n}", number);
}

/** A signed ledger amount: "+600 credits", "−600 credits" (a real minus sign). */
export function formatSignedCredits(n: number, locale: string, forms: CreditForms): string {
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${formatCredits(Math.abs(n), locale, forms)}`;
}
