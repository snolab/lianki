import { t, type DeclarationContent } from "intlayer";
import { describeKeys } from "@/lib/i18n-context";

/**
 * The owner's switch between lianki.com and his whole-page dev server, labelled
 * "live trial" / "live 试用版" in the UI: trial code on production data
 * (docs/dev-whole-page.md, "The profile menu switch"). Only the site owner
 * ever sees these: the server leaves them out for everyone else.
 */
const dictionary = {
  key: "dev-switch",
  content: {
    open: t({
      en: "Live trial (production data)",
      zh: "live 试用版（生产数据）",
      hi: "लाइव (live) ट्रायल (प्रोडक्शन डेटा)",
      es: "Versión de prueba live (datos de producción)",
      fr: "Version d'essai live (données de production)",
      ar: "النسخة التجريبية live (بيانات الإنتاج)",
      bn: "লাইভ (live) ট্রায়াল (প্রোডাকশন ডেটা)",
      pt: "Versão de teste live (dados de produção)",
      ru: "Пробная версия live (рабочие данные)",
      ur: "لائیو (live) ٹرائل (پروڈکشن ڈیٹا)",
      id: "Versi uji live (data produksi)",
      de: "Live-Testversion (Produktionsdaten)",
      ja: "live 試用版（本番データ）",
      sw: "Toleo la majaribio live (data halisi)",
      mr: "लाइव्ह (live) ट्रायल (प्रॉडक्शन डेटा)",
      ko: "live 체험판 (운영 데이터)",
    }),
    off: t({
      en: "Live trial is not running",
      zh: "live 试用版未启动",
      hi: "लाइव (live) ट्रायल चालू नहीं है",
      es: "La versión de prueba live no está en marcha",
      fr: "La version d'essai live n'est pas lancée",
      ar: "النسخة التجريبية live غير مشغّلة",
      bn: "লাইভ (live) ট্রায়াল চালু নেই",
      pt: "A versão de teste live não está em execução",
      ru: "Пробная версия live не запущена",
      ur: "لائیو (live) ٹرائل چل نہیں رہا",
      id: "Versi uji live tidak berjalan",
      de: "Live-Testversion läuft nicht",
      ja: "live 試用版は起動していません",
      sw: "Toleo la majaribio live halifanyi kazi",
      mr: "लाइव्ह (live) ट्रायल सुरू नाही",
      ko: "live 체험판이 실행 중이 아님",
    }),
    checking: t({
      en: "Checking the live trial…",
      zh: "正在检查 live 试用版…",
      hi: "लाइव (live) ट्रायल जाँचा जा रहा है…",
      es: "Comprobando la versión de prueba live…",
      fr: "Vérification de la version d'essai live…",
      ar: "جارٍ التحقق من النسخة التجريبية live…",
      bn: "লাইভ (live) ট্রায়াল দেখা হচ্ছে…",
      pt: "Verificando a versão de teste live…",
      ru: "Проверяем пробную версию live…",
      ur: "لائیو (live) ٹرائل چیک ہو رہا ہے…",
      id: "Memeriksa versi uji live…",
      de: "Live-Testversion wird geprüft…",
      ja: "live 試用版を確認中…",
      sw: "Inakagua toleo la majaribio live…",
      mr: "लाइव्ह (live) ट्रायल तपासत आहे…",
      ko: "live 체험판 확인 중…",
    }),
    back: t({
      en: "Back to lianki.com",
      zh: "返回 lianki.com",
      hi: "lianki.com पर वापस जाएँ",
      es: "Volver a lianki.com",
      fr: "Retour à lianki.com",
      ar: "العودة إلى lianki.com",
      bn: "lianki.com-এ ফিরে যান",
      pt: "Voltar para lianki.com",
      ru: "Вернуться на lianki.com",
      ur: "lianki.com پر واپس جائیں",
      id: "Kembali ke lianki.com",
      de: "Zurück zu lianki.com",
      ja: "lianki.com に戻る",
      sw: "Rudi lianki.com",
      mr: "lianki.com वर परत जा",
      ko: "lianki.com으로 돌아가기",
    }),
    badge: t({
      en: "Live trial · production data",
      zh: "live 试用版 · 生产数据",
      hi: "लाइव (live) ट्रायल · प्रोडक्शन डेटा",
      es: "Prueba live · datos de producción",
      fr: "Essai live · données de production",
      ar: "تجريبية live · بيانات الإنتاج",
      bn: "লাইভ (live) ট্রায়াল · প্রোডাকশন ডেটা",
      pt: "Teste live · dados de produção",
      ru: "Пробная live · рабочие данные",
      ur: "لائیو (live) ٹرائل · پروڈکشن ڈیٹا",
      id: "Uji live · data produksi",
      de: "Live-Test · Produktionsdaten",
      ja: "live 試用版 · 本番データ",
      sw: "Majaribio live · data halisi",
      mr: "लाइव्ह (live) ट्रायल · प्रॉडक्शन डेटा",
      ko: "live 체험판 · 운영 데이터",
    }),
  },
};

const context: Record<keyof typeof dictionary.content, string> = {
  open: 'Item in the account (profile) dropdown menu, seen only by the site owner: opens the current page on the "live trial" — his newest, not yet released (trial) code, running live on the real production database, so whatever he does there changes his real data. Name it as a trial version of the app (like a beta), not a preview or a demo; keep the word "live" (in Latin letters, optionally beside a local transliteration) and keep the warning in brackets that the data is real.',
  off: 'The same menu item, greyed out and not tappable, when the live trial (owner-only trial code on production data) is not running at the moment. Short statement, not an error message; keep the word "live".',
  checking:
    'The same menu item while the menu checks, once, whether the live trial (owner-only trial code on production data) is running. Short progress text ending in an ellipsis; keep the word "live".',
  back: "Item in the same account menu, shown only inside the live trial (owner-only trial code on production data): returns to the same page on the public released site. Imperative phrase; keep lianki.com as is.",
  badge:
    'Small warning label in the top bar of every page of the live trial — the owner\'s trial code running on the real production data, owner only — so he never mistakes it for the public site. Two short noun phrases joined by a middle dot: the name (keep the word "live") and that the data is real.',
};

export default {
  ...dictionary,
  title: "The owner's live-trial switch in the account menu",
  description: describeKeys(
    'Owner-only: the switch between the public site (lianki.com) and the "live trial" — his newest trial code, running live on the real production database. Call it a live trial version (like a beta), never a preview, demo or dev server; keep the word "live" recognisable in every language. Lianki and lianki.com are names.',
    context,
  ),
} satisfies DeclarationContent;
