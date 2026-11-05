import { t, type DeclarationContent } from "intlayer";
import { describeKeys } from "@/lib/i18n-context";

/**
 * Learner level names (lib/levels.ts, docs/levels.md). One set of level ids;
 * each locale names them from its own ladder (owner, Slack 2026-11-05):
 * zh / ja / ko a xianxia cultivation ladder, every other locale a lotus-growth
 * ladder. So the zh value is not a translation of the en one — 炼气 is the
 * first cultivation realm, Seed the first lotus stage.
 */
const dictionary = {
  key: "learner-levels",
  content: {
    lv1: t({
      en: "Seed",
      zh: "炼气",
      hi: "बीज",
      es: "Semilla",
      fr: "Graine",
      ar: "بذرة",
      bn: "বীজ",
      pt: "Semente",
      ru: "Семя",
      ur: "بیج",
      id: "Benih",
      de: "Samen",
      ja: "錬気",
      sw: "Mbegu",
      mr: "बीज",
      ko: "연기",
    }),
    lv2: t({
      en: "Root",
      zh: "筑基",
      hi: "जड़",
      es: "Raíz",
      fr: "Racine",
      ar: "جذر",
      bn: "শিকড়",
      pt: "Raiz",
      ru: "Корень",
      ur: "جڑ",
      id: "Akar",
      de: "Wurzel",
      ja: "築基",
      sw: "Mzizi",
      mr: "मूळ",
      ko: "축기",
    }),
    lv3: t({
      en: "Stem",
      zh: "金丹",
      hi: "तना",
      es: "Tallo",
      fr: "Tige",
      ar: "ساق",
      bn: "কাণ্ড",
      pt: "Caule",
      ru: "Стебель",
      ur: "تنا",
      id: "Batang",
      de: "Stängel",
      ja: "金丹",
      sw: "Shina",
      mr: "देठ",
      ko: "금단",
    }),
    lv4: t({
      en: "Bud",
      zh: "元婴",
      hi: "कली",
      es: "Capullo",
      fr: "Bouton",
      ar: "برعم",
      bn: "কুঁড়ি",
      pt: "Botão",
      ru: "Бутон",
      ur: "کلی",
      id: "Kuncup",
      de: "Knospe",
      ja: "元嬰",
      sw: "Tumba",
      mr: "कळी",
      ko: "원영",
    }),
    lv5: t({
      en: "Bloom",
      zh: "化神",
      hi: "फूल",
      es: "Flor",
      fr: "Fleur",
      ar: "زهرة",
      bn: "ফুল",
      pt: "Flor",
      ru: "Цветок",
      ur: "پھول",
      id: "Bunga",
      de: "Blüte",
      ja: "化神",
      sw: "Ua",
      mr: "फूल",
      ko: "화신",
    }),
    lv6: t({
      en: "Lotus",
      zh: "炼虚",
      hi: "कमल",
      es: "Loto",
      fr: "Lotus",
      ar: "لوتس",
      bn: "পদ্ম",
      pt: "Lótus",
      ru: "Лотос",
      ur: "کنول",
      id: "Teratai",
      de: "Lotus",
      ja: "錬虚",
      sw: "Yungiyungi",
      mr: "कमळ",
      ko: "연허",
    }),
  },
};

const ABOUT =
  "Name of a learner level, shown as a short label next to (never inside) its badge: a small chip in the navigation and the learner's profile.";
const LADDERS =
  "zh, ja and ko use the xianxia cultivation realms in order (炼气, 筑基, 金丹, 元婴, 化神, 炼虚; ja in Japanese kanji, ko in the usual Korean reading); every other locale uses the lotus-growth stage in that locale's plain word.";

const context: Record<keyof typeof dictionary.content, string> = {
  lv1: `${ABOUT} Level 1 of 6, the first: using Lianki without an account. Lotus ladder: a seed lying in the mud (one noun, "Seed"). ${LADDERS} Cultivation: 炼气, qi refining, the first realm.`,
  lv2: `${ABOUT} Level 2 of 6: signed in with a free account. Lotus ladder: the seed has put down roots (one noun, "Root"). ${LADDERS} Cultivation: 筑基, foundation establishment.`,
  lv3: `${ABOUT} Level 3 of 6: the entry level on paying. Lotus ladder: a stem rising through the water (one noun, "Stem"). ${LADDERS} Cultivation: 金丹, golden core.`,
  lv4: `${ABOUT} Level 4 of 6, reached by learning progress. Lotus ladder: a closed flower bud above the water (one noun, "Bud"). ${LADDERS} Cultivation: 元婴, nascent soul.`,
  lv5: `${ABOUT} Level 5 of 6, reached by learning progress. Lotus ladder: the flower opening (one noun naming an open flower, "Bloom"). ${LADDERS} Cultivation: 化神, spirit transformation.`,
  lv6: `${ABOUT} Level 6 of 6, the highest, reached by learning progress. Lotus ladder: the full lotus flower (the locale's name of the lotus flower, "Lotus"). ${LADDERS} Cultivation: 炼虚, void refinement.`,
};

export default {
  ...dictionary,
  title: "Learner level names (badges in the nav and profile)",
  description: describeKeys(
    "Six learner levels, one id each. Each value is a single short name, title-cased where the locale capitalises nouns, no article, no number. The badge is drawn separately; the name sits beside it. Lianki is a name.",
    context,
  ),
} satisfies DeclarationContent;
