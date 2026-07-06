import { t, type Dictionary } from "intlayer";

// A content dictionary. `vite-intlayer` compiles all *.content.ts into typed
// dictionaries; components read them with useIntlayer("home").
const homeContent = {
  key: "home",
  content: {
    title: t({ en: "Lianki", ja: "リアンキ", zh: "练记", ko: "리안키" }),
    tagline: t({
      en: "Spaced-repetition for the things you read and watch.",
      ja: "読んだり見たりしたものを間隔反復で。",
      zh: "用间隔重复记住你读过和看过的东西。",
      ko: "읽고 본 것을 간격 반복으로.",
    }),
  },
} satisfies Dictionary;

export default homeContent;
