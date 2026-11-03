import { t, type DeclarationContent } from "intlayer";
import { describeKeys } from "@/lib/i18n-context";

/**
 * The owner's switch between lianki.com and his whole-page dev server, called
 * "Preview build" / 「预览版」 in the UI (owner, 2026-11-03 14:45 JST): his
 * trial code on production data (docs/dev-whole-page.md, "The profile menu
 * switch"). Only the site owner ever sees these: the server leaves them out
 * for everyone else.
 */
const dictionary = {
  key: "dev-switch",
  content: {
    name: t({
      en: "Preview build",
      zh: "预览版",
      hi: "प्रीव्यू बिल्ड",
      es: "Versión preliminar",
      fr: "Version preview",
      ar: "النسخة التجريبية",
      bn: "প্রিভিউ বিল্ড",
      pt: "Versão de pré-visualização",
      ru: "Предварительная версия",
      ur: "پری ویو بلڈ",
      id: "Versi pratinjau",
      de: "Vorschauversion",
      ja: "プレビュー版",
      sw: "Toleo la hakikisho",
      mr: "प्रीव्ह्यू बिल्ड",
      ko: "미리보기 버전",
    }),
    off: t({
      en: "Preview build is not running",
      zh: "预览版未启动",
      hi: "प्रीव्यू बिल्ड चालू नहीं है",
      es: "La versión preliminar no está en marcha",
      fr: "La version preview n'est pas lancée",
      ar: "النسخة التجريبية غير مشغّلة",
      bn: "প্রিভিউ বিল্ড চালু নেই",
      pt: "A versão de pré-visualização não está em execução",
      ru: "Предварительная версия не запущена",
      ur: "پری ویو بلڈ چل نہیں رہا",
      id: "Versi pratinjau tidak berjalan",
      de: "Vorschauversion läuft nicht",
      ja: "プレビュー版は起動していません",
      sw: "Toleo la hakikisho halifanyi kazi",
      mr: "प्रीव्ह्यू बिल्ड सुरू नाही",
      ko: "미리보기 버전이 실행 중이 아님",
    }),
    checking: t({
      en: "Checking the preview build…",
      zh: "正在检查预览版…",
      hi: "प्रीव्यू बिल्ड जाँचा जा रहा है…",
      es: "Comprobando la versión preliminar…",
      fr: "Vérification de la version preview…",
      ar: "جارٍ التحقق من النسخة التجريبية…",
      bn: "প্রিভিউ বিল্ড দেখা হচ্ছে…",
      pt: "Verificando a versão de pré-visualização…",
      ru: "Проверяем предварительную версию…",
      ur: "پری ویو بلڈ چیک ہو رہا ہے…",
      id: "Memeriksa versi pratinjau…",
      de: "Vorschauversion wird geprüft…",
      ja: "プレビュー版を確認中…",
      sw: "Inakagua toleo la hakikisho…",
      mr: "प्रीव्ह्यू बिल्ड तपासत आहे…",
      ko: "미리보기 버전 확인 중…",
    }),
  },
};

const ABOUT =
  "The preview build is the site owner's newest, not yet released trial code, running on the real production database: what he does there changes his real data. Owner only.";

const context: Record<keyof typeof dictionary.content, string> = {
  name: `${ABOUT} Label of an on/off toggle switch (no caption under it) in the account (profile) dropdown menu: on = he is on the preview build, off = the public site lianki.com; flipping it moves the current page there. It is also the screen-reader label of a small blue dot on the menu's button, shown only on the preview build. A short noun naming a preview/pre-release version of the app (the locale's usual word for a preview build), not a demo. It is the menu's only preview control: a small 'Dev parts' chip may sit under it in the same row (another dictionary).`,
  off: `${ABOUT} The switch's label when greyed out and not tappable, because the preview build is not running at the moment. Short statement, not an error message.`,
  checking: `${ABOUT} The switch's label while the menu checks, once, whether the preview build is running. Short progress text ending in an ellipsis.`,
};

export default {
  ...dictionary,
  title: "The owner's preview-build switch in the account menu",
  description: describeKeys(
    "Owner-only: a switch between the public site (lianki.com) and the preview build — his trial code running on the real production database. Lianki and lianki.com are names.",
    context,
  ),
} satisfies DeclarationContent;
