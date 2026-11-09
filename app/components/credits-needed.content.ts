import { t, type DeclarationContent } from "intlayer";
import { describeKeys } from "@/lib/i18n-context";

/**
 * The notice every page shows when a paid feature was refused for want of
 * credits (app/components/NoCreditsNotice.tsx, lib/payments/no-credits-watch.ts;
 * docs/payments.md, "What costs credits").
 */
const dictionary = {
  key: "credits-needed",
  content: {
    message: t({
      en: "Not enough credits for this. AI features and generated speech are paid from your credits.",
      zh: "积分不足，无法完成此操作。AI 功能和语音生成会从你的积分中扣除。",
      hi: "इसके लिए पर्याप्त क्रेडिट नहीं हैं। AI सुविधाएँ और बनाई गई आवाज़ आपके क्रेडिट से चुकाई जाती हैं।",
      es: "No tienes créditos suficientes para esto. Las funciones de IA y la voz generada se pagan con tus créditos.",
      fr: "Pas assez de crédits pour cela. Les fonctions d'IA et la voix générée sont payées avec vos crédits.",
      ar: "لا يكفي رصيدك لهذا. تُدفع ميزات الذكاء الاصطناعي والصوت المُولَّد من رصيدك.",
      bn: "এর জন্য যথেষ্ট ক্রেডিট নেই। AI সুবিধা আর তৈরি করা কণ্ঠস্বর আপনার ক্রেডিট থেকে দেওয়া হয়।",
      pt: "Créditos insuficientes para isso. Os recursos de IA e a voz gerada são pagos com seus créditos.",
      ru: "Недостаточно кредитов для этого. Функции ИИ и синтез речи оплачиваются вашими кредитами.",
      ur: "اس کے لیے کافی کریڈٹس نہیں ہیں۔ AI فیچرز اور بنائی گئی آواز آپ کے کریڈٹس سے ادا ہوتی ہیں۔",
      id: "Kredit tidak cukup untuk ini. Fitur AI dan suara yang dibuat dibayar dari kredit Anda.",
      de: "Nicht genug Credits dafür. KI-Funktionen und erzeugte Sprache werden mit deinen Credits bezahlt.",
      ja: "クレジットが足りません。AI機能と音声の生成はクレジットから支払われます。",
      sw: "Krediti hazitoshi kwa hili. Vipengele vya AI na sauti inayotengenezwa hulipwa kwa krediti zako.",
      mr: "यासाठी पुरेसे क्रेडिट्स नाहीत. AI सुविधा आणि तयार केलेला आवाज तुमच्या क्रेडिट्समधून दिला जातो.",
      ko: "크레딧이 부족해요. AI 기능과 음성 생성은 크레딧으로 결제돼요.",
    }),
    topUp: t({
      en: "Get credits",
      zh: "获取积分",
      hi: "क्रेडिट पाएँ",
      es: "Conseguir créditos",
      fr: "Obtenir des crédits",
      ar: "احصل على رصيد",
      bn: "ক্রেডিট নিন",
      pt: "Obter créditos",
      ru: "Получить кредиты",
      ur: "کریڈٹس حاصل کریں",
      id: "Dapatkan kredit",
      de: "Credits holen",
      ja: "クレジットを追加",
      sw: "Pata krediti",
      mr: "क्रेडिट्स मिळवा",
      ko: "크레딧 받기",
    }),
    close: t({
      en: "Close",
      zh: "关闭",
      hi: "बंद करें",
      es: "Cerrar",
      fr: "Fermer",
      ar: "إغلاق",
      bn: "বন্ধ করুন",
      pt: "Fechar",
      ru: "Закрыть",
      ur: "بند کریں",
      id: "Tutup",
      de: "Schließen",
      ja: "閉じる",
      sw: "Funga",
      mr: "बंद करा",
      ko: "닫기",
    }),
  },
};

const context: Record<keyof typeof dictionary.content, string> = {
  message:
    "A small notice that slides up at the bottom of any page when something the user just asked for (an AI translation, a word meaning, a transcript polish, read-aloud audio, voice typing, an AI-made sentence) was not done because their prepaid credit balance (the wallet on the Membership page) does not cover it. A link (topUp) follows it. Friendly and plain, no numbers or prices. Use the same word for 'credits' as the Membership page's wallet (积分 in Chinese). Two short sentences: not enough credits for this; AI features and generated speech are paid from credits.",
  topUp:
    "Link right after the not-enough-credits notice (message); it opens the Membership page where the user adds credits to their wallet. 2–3 words, an action; the same wording as the Learning Partner chat's 'Get credits' link.",
  close:
    "Accessible label (screen readers, tooltip) of the × button that dismisses the not-enough-credits notice. One word, a verb.",
};

export default {
  ...dictionary,
  title: "The not-enough-credits notice on any page",
  description: describeKeys(
    "One notice, shown on any page, when a paid feature (AI or generated speech) was refused because the user's credits do not cover it, with a link to add credits.",
    context,
  ),
} satisfies DeclarationContent;
