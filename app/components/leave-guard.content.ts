import { t, type DeclarationContent } from "intlayer";
import { describeKeys } from "@/lib/i18n-context";

/**
 * The leave guard (app/components/LeaveGuard.tsx, lib/page-dirty.ts): the
 * confirm shown before going to another page, tab or panel while a form
 * holds text that was typed but not saved.
 */
const dictionary = {
  key: "leave-guard",
  content: {
    unsaved: t({
      en: "You have unsaved changes. Leave anyway?",
      zh: "有未保存的内容，确定离开吗？",
      hi: "आपके कुछ बदलाव सहेजे नहीं गए हैं। फिर भी छोड़ें?",
      es: "Tienes cambios sin guardar. ¿Salir de todos modos?",
      fr: "Vous avez des modifications non enregistrées. Quitter quand même ?",
      ar: "لديك تغييرات غير محفوظة. هل تريد المغادرة على أي حال؟",
      bn: "আপনার কিছু পরিবর্তন সংরক্ষণ করা হয়নি। তবুও চলে যাবেন?",
      pt: "Você tem alterações não salvas. Sair mesmo assim?",
      ru: "Есть несохранённые изменения. Всё равно уйти?",
      ur: "آپ کی کچھ تبدیلیاں محفوظ نہیں ہوئیں۔ پھر بھی چھوڑیں؟",
      id: "Ada perubahan yang belum disimpan. Tetap tinggalkan?",
      de: "Du hast ungespeicherte Änderungen. Trotzdem verlassen?",
      ja: "保存されていない内容があります。移動しますか？",
      sw: "Una mabadiliko ambayo hayajahifadhiwa. Uondoke hata hivyo?",
      mr: "तुमचे काही बदल जतन झालेले नाहीत. तरीही बाहेर पडायचे?",
      ko: "저장하지 않은 내용이 있습니다. 그래도 나가시겠습니까?",
    }),
  },
};

const context: Record<keyof typeof dictionary.content, string> = {
  unsaved:
    "Text of the browser's OK/Cancel confirm dialog, shown when the user taps a link to another page, or switches a tab or panel, while a form on this page holds text they typed but did not save or send. OK leaves and loses that text; Cancel stays. A statement then a yes/no question; plain and short, no product names.",
};

export default {
  ...dictionary,
  title: "The unsaved-changes confirm before leaving a page",
  description: describeKeys(
    "One confirm dialog that guards every form in the app against being left with unsaved typing (other page, tab or panel).",
    context,
  ),
} satisfies DeclarationContent;
