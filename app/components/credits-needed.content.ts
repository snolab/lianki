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
    paused: t({
      en: "This feature is temporarily unavailable. Nothing was charged. Please try again later.",
      zh: "此功能暂时无法使用，未扣除任何积分。请稍后再试。",
      hi: "यह सुविधा अभी अस्थायी रूप से उपलब्ध नहीं है। कोई क्रेडिट नहीं काटा गया। कृपया बाद में फिर कोशिश करें।",
      es: "Esta función no está disponible temporalmente. No se ha cobrado nada. Inténtalo de nuevo más tarde.",
      fr: "Cette fonction est temporairement indisponible. Rien n'a été débité. Réessayez plus tard.",
      ar: "هذه الميزة غير متاحة مؤقتًا. لم يُخصم أي رصيد. يُرجى المحاولة لاحقًا.",
      bn: "এই সুবিধাটি সাময়িকভাবে বন্ধ আছে। কোনো ক্রেডিট কাটা হয়নি। পরে আবার চেষ্টা করুন।",
      pt: "Este recurso está temporariamente indisponível. Nada foi cobrado. Tente novamente mais tarde.",
      ru: "Эта функция временно недоступна. Ничего не списано. Попробуйте позже.",
      ur: "یہ فیچر عارضی طور پر دستیاب نہیں ہے۔ کوئی کریڈٹ نہیں کاٹا گیا۔ براہ کرم بعد میں دوبارہ کوشش کریں۔",
      id: "Fitur ini untuk sementara tidak tersedia. Tidak ada kredit yang dipotong. Coba lagi nanti.",
      de: "Diese Funktion ist vorübergehend nicht verfügbar. Es wurde nichts abgebucht. Bitte versuche es später erneut.",
      ja: "この機能は一時的に利用できません。クレジットは使われていません。しばらくしてからお試しください。",
      sw: "Kipengele hiki hakipatikani kwa muda. Hakuna krediti iliyokatwa. Tafadhali jaribu tena baadaye.",
      mr: "ही सुविधा तात्पुरती उपलब्ध नाही. कोणतेही क्रेडिट्स वजा झाले नाहीत. कृपया नंतर पुन्हा प्रयत्न करा.",
      ko: "이 기능은 일시적으로 사용할 수 없어요. 크레딧은 차감되지 않았어요. 잠시 후 다시 시도해 주세요.",
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
    needLine: t({
      en: "To start, you need at least {need} credits; to finish the whole task, {recommended} are recommended (you have {have}).",
      zh: "开始至少需要 {need} 积分，完成整个任务建议 {recommended} 积分（当前 {have}）。",
      ja: "始めるには少なくとも {need} クレジット、全体を終えるには {recommended} クレジットがおすすめです（現在 {have}）。",
      ko: "시작하려면 최소 {need} 크레딧, 작업 전체를 마치려면 {recommended} 크레딧을 권장해요(현재 {have}).",
      hi: "शुरू करने के लिए कम से कम {need} क्रेडिट चाहिए; पूरा काम खत्म करने के लिए {recommended} क्रेडिट की सलाह है (अभी {have})।",
      es: "Para empezar necesitas al menos {need} créditos; para terminar toda la tarea se recomiendan {recommended} (tienes {have}).",
      fr: "Pour commencer, il faut au moins {need} crédits ; pour finir toute la tâche, {recommended} sont conseillés (vous en avez {have}).",
      ar: "للبدء تحتاج على الأقل {need} من الرصيد؛ ولإنهاء المهمة كلها يُنصح بـ {recommended} (لديك {have}).",
      bn: "শুরু করতে অন্তত {need} ক্রেডিট লাগবে; পুরো কাজ শেষ করতে {recommended} ক্রেডিট রাখার পরামর্শ (এখন {have})।",
      pt: "Para começar, você precisa de pelo menos {need} créditos; para terminar a tarefa toda, recomendamos {recommended} (você tem {have}).",
      ru: "Чтобы начать, нужно не меньше {need} кредитов; чтобы завершить всю задачу, рекомендуем {recommended} (сейчас {have}).",
      ur: "شروع کرنے کے لیے کم از کم {need} کریڈٹس چاہئیں؛ پورا کام ختم کرنے کے لیے {recommended} کی سفارش ہے (ابھی {have})۔",
      id: "Untuk mulai, perlu setidaknya {need} kredit; untuk menyelesaikan seluruh tugas, disarankan {recommended} (saat ini {have}).",
      de: "Zum Starten brauchst du mindestens {need} Credits; um die ganze Aufgabe fertigzustellen, werden {recommended} empfohlen (du hast {have}).",
      sw: "Kuanza unahitaji angalau krediti {need}; kumaliza kazi yote, krediti {recommended} zinapendekezwa (una {have}).",
      mr: "सुरू करण्यासाठी किमान {need} क्रेडिट्स लागतील; संपूर्ण काम पूर्ण करण्यासाठी {recommended} क्रेडिट्स सुचवले आहेत (सध्या {have}).",
    }),
    needShort: t({
      en: "You need at least {need} credits ({short} more).",
      zh: "至少需要 {need} 积分（还差 {short}）。",
      ja: "少なくとも {need} クレジット必要です（あと {short}）。",
      ko: "최소 {need} 크레딧이 필요해요({short} 부족).",
      hi: "कम से कम {need} क्रेडिट चाहिए ({short} और)।",
      es: "Necesitas al menos {need} créditos (te faltan {short}).",
      fr: "Il faut au moins {need} crédits (il en manque {short}).",
      ar: "تحتاج على الأقل {need} من الرصيد (ينقصك {short}).",
      bn: "অন্তত {need} ক্রেডিট লাগবে (আরও {short})।",
      pt: "Você precisa de pelo menos {need} créditos (faltam {short}).",
      ru: "Нужно не меньше {need} кредитов (не хватает {short}).",
      ur: "کم از کم {need} کریڈٹس چاہئیں ({short} کم ہیں)۔",
      id: "Perlu setidaknya {need} kredit (kurang {short}).",
      de: "Du brauchst mindestens {need} Credits (es fehlen {short}).",
      sw: "Unahitaji angalau krediti {need} (zimepungua {short}).",
      mr: "किमान {need} क्रेडिट्स लागतील ({short} कमी).",
    }),
  },
};

const context: Record<keyof typeof dictionary.content, string> = {
  message:
    "A small notice that slides up at the bottom of any page when something the user just asked for (an AI translation, a word meaning, a transcript polish, read-aloud audio, voice typing, an AI-made sentence) was not done because their prepaid credit balance (the wallet on the Membership page) does not cover it. A link (topUp) follows it. Friendly and plain, no numbers or prices. Use the same word for 'credits' as the Membership page's wallet (积分 in Chinese). Two short sentences: not enough credits for this; AI features and generated speech are paid from credits.",
  topUp:
    "Link right after the not-enough-credits notice (message); it opens the Membership page where the user adds credits to their wallet. 2–3 words, an action; the same wording as the Learning Partner chat's 'Get credits' link.",
  paused:
    "The same bottom notice, shown instead of the not-enough-credits text when a paid feature (an AI translation, a word meaning, read-aloud audio, voice typing…) is switched off for everyone for a while because its cost outran our prices; the user was not charged. No link follows it. Calm and plain, no technical reason, no numbers. Three short sentences: temporarily unavailable; nothing was charged (use the wallet's word for credits where natural); try again later.",
  close:
    "Accessible label (screen readers, tooltip) of the × button that dismisses the not-enough-credits notice. One word, a verb.",
  needLine:
    "The not-enough-credits notice (and the same line wherever a paid action is refused) when the whole task needs more than its start: {need} = the minimum to start (the first hold), {recommended} = the balance recommended to finish the whole task without stopping midway (from past real costs), {have} = the current balance. All whole credits; keep the three placeholders. Use the wallet's word for credits (积分 in Chinese). Owner's Chinese wording: 开始至少需要 N 积分，完成整个任务建议 R 积分（当前 H）.",
  needShort:
    "The not-enough-credits line when the task is a single step (start = finish): {need} = the credits it needs, {short} = how many the user is missing. Whole credits; keep both placeholders. Use the wallet's word for credits (积分 in Chinese). Owner's Chinese wording: 至少需要 N 积分（还差 M）.",
};

export default {
  ...dictionary,
  title: "The not-enough-credits notice on any page",
  description: describeKeys(
    "One notice, shown on any page, when a paid feature (AI or generated speech) was refused because the user's credits do not cover it, with a link to add credits.",
    context,
  ),
} satisfies DeclarationContent;
