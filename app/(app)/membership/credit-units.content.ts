import { t, type DeclarationContent } from "intlayer";
import { describeKeys, flattenContext, type KeyContext } from "@/lib/i18n-context";

/**
 * Wallet amounts in credits, one phrase per CLDR plural category
 * (`Intl.PluralRules`), read by `formatCredits` (lib/payments/credit-units.ts).
 * A locale that has no such category repeats its "other" phrase.
 */
const dictionary = {
  key: "credit-units",
  content: {
    amount: {
      zero: t({
        en: "{n} credits",
        zh: "{n} 积分",
        ja: "{n} クレジット",
        ko: "{n} 크레딧",
        hi: "{n} क्रेडिट",
        es: "{n} créditos",
        fr: "{n} crédits",
        ar: "{n} وحدة رصيد",
        bn: "{n} ক্রেডিট",
        pt: "{n} créditos",
        ru: "{n} кредита",
        ur: "{n} کریڈٹ",
        id: "{n} kredit",
        de: "{n} Credits",
        sw: "krediti {n}",
        mr: "{n} क्रेडिट",
      }),
      one: t({
        en: "{n} credit",
        zh: "{n} 积分",
        ja: "{n} クレジット",
        ko: "{n} 크레딧",
        hi: "{n} क्रेडिट",
        es: "{n} crédito",
        fr: "{n} crédit",
        ar: "{n} وحدة رصيد",
        bn: "{n} ক্রেডিট",
        pt: "{n} crédito",
        ru: "{n} кредит",
        ur: "{n} کریڈٹ",
        id: "{n} kredit",
        de: "{n} Credit",
        sw: "krediti {n}",
        mr: "{n} क्रेडिट",
      }),
      two: t({
        en: "{n} credits",
        zh: "{n} 积分",
        ja: "{n} クレジット",
        ko: "{n} 크레딧",
        hi: "{n} क्रेडिट",
        es: "{n} créditos",
        fr: "{n} crédits",
        ar: "{n} وحدتا رصيد",
        bn: "{n} ক্রেডিট",
        pt: "{n} créditos",
        ru: "{n} кредита",
        ur: "{n} کریڈٹ",
        id: "{n} kredit",
        de: "{n} Credits",
        sw: "krediti {n}",
        mr: "{n} क्रेडिट",
      }),
      few: t({
        en: "{n} credits",
        zh: "{n} 积分",
        ja: "{n} クレジット",
        ko: "{n} 크레딧",
        hi: "{n} क्रेडिट",
        es: "{n} créditos",
        fr: "{n} crédits",
        ar: "{n} وحدات رصيد",
        bn: "{n} ক্রেডিট",
        pt: "{n} créditos",
        ru: "{n} кредита",
        ur: "{n} کریڈٹ",
        id: "{n} kredit",
        de: "{n} Credits",
        sw: "krediti {n}",
        mr: "{n} क्रेडिट",
      }),
      many: t({
        en: "{n} credits",
        zh: "{n} 积分",
        ja: "{n} クレジット",
        ko: "{n} 크레딧",
        hi: "{n} क्रेडिट",
        es: "{n} de créditos",
        fr: "{n} de crédits",
        ar: "{n} وحدة رصيد",
        bn: "{n} ক্রেডিট",
        pt: "{n} de créditos",
        ru: "{n} кредитов",
        ur: "{n} کریڈٹ",
        id: "{n} kredit",
        de: "{n} Credits",
        sw: "krediti {n}",
        mr: "{n} क्रेडिट",
      }),
      other: t({
        en: "{n} credits",
        zh: "{n} 积分",
        ja: "{n} クレジット",
        ko: "{n} 크레딧",
        hi: "{n} क्रेडिट",
        es: "{n} créditos",
        fr: "{n} crédits",
        ar: "{n} وحدة رصيد",
        bn: "{n} ক্রেডিট",
        pt: "{n} créditos",
        ru: "{n} кредита",
        ur: "{n} کریڈٹ",
        id: "{n} kredit",
        de: "{n} Credits",
        sw: "krediti {n}",
        mr: "{n} क्रेडिट",
      }),
    },
  },
};

const shared =
  "An amount of Lianki credits (the prepaid wallet's unit; one credit is bought with ¥1). {n} is the number, already formatted for the locale (1,200) — keep {n} exactly once. Shown in the balance on /membership, beside pass prices paid from the balance, in the wallet history (+/− in front), and on top-up buttons after the yen price ('¥600 → 600 credits'). Use the word apps in this language use for prepaid credits, not 'loan', not money, not points from a game; noun only, no currency sign.";

const context: KeyContext<typeof dictionary.content> = {
  amount: {
    zero: `${shared} Form for the CLDR plural category 'zero' (only Arabic uses it; elsewhere same as 'other').`,
    one: `${shared} Form for the CLDR plural category 'one' (en: 1 credit; fr/pt also 0).`,
    two: `${shared} Form for the CLDR plural category 'two' (only Arabic uses it; elsewhere same as 'other').`,
    few: `${shared} Form for the CLDR plural category 'few' (ru 2–4, ar 3–10; elsewhere same as 'other').`,
    many: `${shared} Form for the CLDR plural category 'many' (ru 5–20, ar 11–99, es/fr/pt a round million; elsewhere same as 'other').`,
    other: `${shared} Form for the CLDR plural category 'other', the general plural and the fallback.`,
  },
};

export default {
  ...dictionary,
  title: "Credit amounts (wallet unit, pluralized)",
  description: describeKeys(
    "How an amount of wallet credits reads in each language, one phrase per plural category. The wallet balance is always shown in credits, never in a currency (owner, 2026-11-03).",
    flattenContext(context),
  ),
} satisfies DeclarationContent;
