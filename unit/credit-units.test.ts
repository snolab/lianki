import { describe, expect, it } from "bun:test";
import units from "@/app/(app)/membership/credit-units.content";
import { formatCredits, formatSignedCredits, type CreditForms } from "@/lib/payments/credit-units";

// Owner (2026-11-03): the wallet balance reads in credits, never a currency.
type Leaf = { translation: Record<string, string> };
const forms = (locale: string): CreditForms => {
  const a = units.content.amount as unknown as Record<string, Leaf>;
  return Object.fromEntries(
    Object.entries(a).map(([cat, leaf]) => [cat, leaf.translation[locale]]),
  ) as CreditForms;
};

describe("formatCredits", () => {
  it("pluralizes and groups digits for the locale", () => {
    expect(formatCredits(1, "en", forms("en"))).toBe("1 credit");
    expect(formatCredits(1200, "en", forms("en"))).toBe("1,200 credits");
    expect(formatCredits(1200, "zh", forms("zh"))).toBe("1,200 积分");
    expect(formatCredits(1, "ru", forms("ru"))).toBe("1 кредит");
    expect(formatCredits(3, "ru", forms("ru"))).toBe("3 кредита");
    expect(formatCredits(600, "ru", forms("ru"))).toMatch(/^600 кредитов$/);
    expect(formatCredits(600, "sw", forms("sw"))).toBe("krediti 600");
  });

  it("has no currency sign in any locale, and {n} exactly once", () => {
    for (const leaf of Object.values(units.content.amount as unknown as Record<string, Leaf>))
      for (const v of Object.values(leaf.translation)) {
        expect(v).not.toMatch(/[¥$€£₹]|JPY|円|日元/);
        expect(v.split("{n}").length).toBe(2);
      }
  });

  it("signs ledger amounts with a real minus", () => {
    expect(formatSignedCredits(600, "en", forms("en"))).toBe("+600 credits");
    expect(formatSignedCredits(-600, "en", forms("en"))).toBe("−600 credits");
  });

  it("falls back to 'other' on an unknown locale tag", () => {
    expect(formatCredits(5, "not a locale!", { other: "{n} c" })).toBe("5 c");
  });
});
