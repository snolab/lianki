import { t, type DeclarationContent } from "intlayer";
import { describeKeys } from "../../../lib/i18n-context";

const dictionary = {
  key: "words-native-audio",
  content: {
    original: t({
      en: "Word pronunciation: original recording · automatically aligned",
      zh: "单词原音（自动对齐）",
      ja: "発音：元の録音・自動位置合わせ",
      ko: "발음: 원본 녹음 · 자동 정렬",
      hi: "उच्चारण: मूल रिकॉर्डिंग · स्वचालित संरेखण",
      es: "Pronunciación: grabación original · alineación automática",
      fr: "Prononciation : enregistrement original · alignement automatique",
      ar: "النطق: التسجيل الأصلي · محاذاة تلقائية",
      bn: "উচ্চারণ: মূল রেকর্ডিং · স্বয়ংক্রিয় মিল",
      pt: "Pronúncia: gravação original · alinhamento automático",
      ru: "Произношение: исходная запись · автоматическая разметка",
      ur: "تلفظ: اصل ریکارڈنگ · خودکار مطابقت",
      id: "Pelafalan: rekaman asli · penyelarasan otomatis",
      de: "Aussprache: Originalaufnahme · automatisch zugeordnet",
      sw: "Matamshi: rekodi asili · upangaji otomatiki",
      mr: "उच्चार: मूळ ध्वनिमुद्रण · स्वयंचलित जुळवणी",
    }),
    synthetic: t({
      en: "Pronunciation: synthesized",
      zh: "发音：合成朗读",
      ja: "発音：合成音声",
      ko: "발음: 합성 음성",
      hi: "उच्चारण: संश्लेषित आवाज़",
      es: "Pronunciación: voz sintetizada",
      fr: "Prononciation : voix de synthèse",
      ar: "النطق: صوت اصطناعي",
      bn: "উচ্চারণ: সংশ্লেষিত কণ্ঠ",
      pt: "Pronúncia: voz sintetizada",
      ru: "Произношение: синтезированная речь",
      ur: "تلفظ: مصنوعی آواز",
      id: "Pelafalan: suara sintetis",
      de: "Aussprache: synthetische Stimme",
      sw: "Matamshi: sauti iliyotengenezwa",
      mr: "उच्चार: संश्लेषित आवाज",
    }),
  },
} satisfies DeclarationContent;
export default {
  ...dictionary,
  description: describeKeys(
    "Source of a word's pronunciation in Lianki's study toolbar. This describes pronunciation only; example sentences and meanings may use synthesized speech.",
    {
      original:
        "Status shown while the word uses the user's private original course recording. The time range was aligned automatically and has not been manually verified; do not imply human verification.",
      synthetic:
        "Status shown when the word uses browser or server synthesized speech, including fallback when an original recording is missing or cannot play. Do not imply it is the original recording.",
    },
  ),
} satisfies DeclarationContent;
