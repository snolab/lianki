import { t, type DeclarationContent } from "intlayer";
import { describeKeys } from "../../../../lib/i18n-context";

/**
 * "My learning activity" on /list: a year of days, each day with reviews
 * marked by a hand-drawn 正 tally (1–5 strokes, the same glyph in every
 * locale). These are its screen-reader labels, tooltip and legend.
 */
const dictionary = {
  key: "activity-tally",
  content: {
    figure: t({
      en: "Reviews per day over the past year",
      zh: "过去一年每天的复习次数",
      ja: "過去1年間の1日ごとの復習回数",
      ko: "지난 1년간 하루 복습 횟수",
      hi: "पिछले एक साल में हर दिन के रिव्यू",
      es: "Repasos por día durante el último año",
      fr: "Révisions par jour sur l'année écoulée",
      ar: "المراجعات في كل يوم خلال العام الماضي",
      bn: "গত এক বছরে প্রতিদিনের রিভিউ",
      pt: "Revisões por dia no último ano",
      ru: "Повторения по дням за последний год",
      ur: "پچھلے ایک سال میں ہر دن کے ریویو",
      id: "Ulasan per hari selama setahun terakhir",
      de: "Wiederholungen pro Tag im letzten Jahr",
      sw: "Marudio kwa kila siku katika mwaka uliopita",
      mr: "गेल्या वर्षभरातील दररोजची उजळणी",
    }),
    dayOne: t({
      en: "{date}: 1 review",
      zh: "{date}：复习 1 次",
      ja: "{date}：復習 1 回",
      ko: "{date}: 복습 1회",
      hi: "{date}: 1 रिव्यू",
      es: "{date}: 1 repaso",
      fr: "{date} : 1 révision",
      ar: "{date}: مراجعة واحدة",
      bn: "{date}: ১টি রিভিউ",
      pt: "{date}: 1 revisão",
      ru: "{date}: 1 повторение",
      ur: "{date}: 1 ریویو",
      id: "{date}: 1 ulasan",
      de: "{date}: 1 Wiederholung",
      sw: "{date}: rudio 1",
      mr: "{date}: 1 उजळणी",
    }),
    dayOther: t({
      en: "{date}: {count} reviews",
      zh: "{date}：复习 {count} 次",
      ja: "{date}：復習 {count} 回",
      ko: "{date}: 복습 {count}회",
      hi: "{date}: {count} रिव्यू",
      es: "{date}: {count} repasos",
      fr: "{date} : {count} révisions",
      ar: "{date} — عدد المراجعات: {count}",
      bn: "{date}: {count}টি রিভিউ",
      pt: "{date}: {count} revisões",
      ru: "{date} — повторений: {count}",
      ur: "{date}: {count} ریویو",
      id: "{date}: {count} ulasan",
      de: "{date}: {count} Wiederholungen",
      sw: "{date}: marudio {count}",
      mr: "{date}: {count} उजळण्या",
    }),
    less: t({
      en: "Lighter",
      zh: "较少",
      ja: "少なめ",
      ko: "적음",
      hi: "कम",
      es: "Menos",
      fr: "Moins",
      ar: "أقل",
      bn: "কম",
      pt: "Menos",
      ru: "Меньше",
      ur: "کم",
      id: "Lebih sedikit",
      de: "Weniger",
      sw: "Kidogo",
      mr: "कमी",
    }),
    more: t({
      en: "Busier",
      zh: "较多",
      ja: "多め",
      ko: "많음",
      hi: "ज़्यादा",
      es: "Más",
      fr: "Plus",
      ar: "أكثر",
      bn: "বেশি",
      pt: "Mais",
      ru: "Больше",
      ur: "زیادہ",
      id: "Lebih banyak",
      de: "Mehr",
      sw: "Zaidi",
      mr: "जास्त",
    }),
    legend: t({
      en: "More strokes mean a busier day compared with your own days",
      zh: "笔画越多，表示这一天比你平时复习得越多",
      ja: "画数が多いほど、普段のあなたと比べて多く復習した日です",
      ko: "획이 많을수록 평소의 나보다 많이 복습한 날입니다",
      hi: "जितनी ज़्यादा रेखाएँ, उतना व्यस्त दिन — आपके अपने दिनों की तुलना में",
      es: "Más trazos: un día con más repasos que tus días habituales",
      fr: "Plus de traits : une journée plus chargée que vos jours habituels",
      ar: "كلما زادت الخطوط كان اليوم أكثر نشاطًا مقارنة بأيامك المعتادة",
      bn: "যত বেশি রেখা, আপনার নিজের দিনগুলোর তুলনায় দিনটি তত ব্যস্ত",
      pt: "Mais traços: um dia com mais revisões do que os seus dias habituais",
      ru: "Чем больше черт, тем насыщеннее день по сравнению с вашими обычными днями",
      ur: "جتنی زیادہ لکیریں، اتنا مصروف دن — آپ کے اپنے دنوں کے مقابلے میں",
      id: "Makin banyak goresan, makin sibuk harinya dibanding hari-hari Anda sendiri",
      de: "Mehr Striche heißt: ein vollerer Tag als deine üblichen Tage",
      sw: "Mistari mingi zaidi inamaanisha siku yenye shughuli zaidi kuliko siku zako za kawaida",
      mr: "जितक्या जास्त रेषा, तितका तुमच्या नेहमीच्या दिवसांपेक्षा व्यस्त दिवस",
    }),
  },
};

const context: Record<keyof typeof dictionary.content, string> = {
  figure:
    "Screen-reader name of the whole activity chart under 'Learning Activity' on /list: a year of days, each day with reviews marked by a 正 tally. A noun phrase, not a sentence.",
  dayOne:
    "Screen-reader label and hover tooltip of one day in the activity chart on /list, when the learner did exactly one review that day (Intl.PluralRules 'one'). Keep {date} (an already localised date) as is. Where the language does not inflect for number, the same wording as dayOther.",
  dayOther:
    "Screen-reader label and hover tooltip of one day in the activity chart on /list, for every other count of reviews that day. Keep {date} and {count} as is. For languages with several plural forms (ru, ar), a label then the number avoids agreement.",
  less: "Small caption at the left end of the chart's legend, before tally glyphs of 1 to 5 strokes: the end with fewer reviews than the learner's other days. One word, comparative adjective.",
  more: "Small caption at the right end of the chart's legend, after tally glyphs of 1 to 5 strokes: the end with more reviews than the learner's other days. One word, comparative adjective.",
  legend:
    "Screen-reader description of the chart's legend on /list: each day's 正 tally has 1 to 5 strokes, more strokes for days the learner reviewed more, relative to that learner's own history (not a fixed number). One sentence, addressed to the learner.",
};

export default {
  ...dictionary,
  title: "/list — the learning activity tally",
  description: describeKeys(
    "The 'Learning Activity' chart on /list: a year of days, where each day with reviews gets a hand-drawn 正 tally of 1 to 5 strokes (the glyph itself is never translated; it is the same in every locale). Stroke counts are relative to the learner's own days. A 'review' is one graded flash card.",
    context,
  ),
} satisfies DeclarationContent;
