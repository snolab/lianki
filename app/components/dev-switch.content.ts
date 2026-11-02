import { t, type DeclarationContent } from "intlayer";
import { describeKeys } from "@/lib/i18n-context";

/**
 * The owner's switch between lianki.com and his whole-page dev server
 * (docs/dev-whole-page.md, "The profile menu switch"). Only the site owner
 * ever sees these: the server leaves them out for everyone else.
 */
const dictionary = {
  key: "dev-switch",
  content: {
    open: t({
      en: "Dev server (production data)",
      zh: "开发服务器（生产数据）",
      hi: "डेव सर्वर (प्रोडक्शन डेटा)",
      es: "Servidor de desarrollo (datos de producción)",
      fr: "Serveur de dev (données de production)",
      ar: "خادم التطوير (بيانات الإنتاج)",
      bn: "ডেভ সার্ভার (প্রোডাকশন ডেটা)",
      pt: "Servidor de desenvolvimento (dados de produção)",
      ru: "Сервер разработки (рабочие данные)",
      ur: "ڈیو سرور (پروڈکشن ڈیٹا)",
      id: "Server dev (data produksi)",
      de: "Dev-Server (Produktionsdaten)",
      ja: "開発サーバー（本番データ）",
      sw: "Seva ya maendeleo (data halisi)",
      mr: "डेव्ह सर्व्हर (प्रॉडक्शन डेटा)",
      ko: "개발 서버 (운영 데이터)",
    }),
    off: t({
      en: "Dev server is off",
      zh: "开发服务器未开启",
      hi: "डेव सर्वर बंद है",
      es: "El servidor de desarrollo está apagado",
      fr: "Le serveur de dev est éteint",
      ar: "خادم التطوير متوقف",
      bn: "ডেভ সার্ভার বন্ধ",
      pt: "O servidor de desenvolvimento está desligado",
      ru: "Сервер разработки выключен",
      ur: "ڈیو سرور بند ہے",
      id: "Server dev mati",
      de: "Dev-Server ist aus",
      ja: "開発サーバーは停止中",
      sw: "Seva ya maendeleo imezimwa",
      mr: "डेव्ह सर्व्हर बंद आहे",
      ko: "개발 서버가 꺼져 있음",
    }),
    checking: t({
      en: "Checking the dev server…",
      zh: "正在检查开发服务器…",
      hi: "डेव सर्वर जाँचा जा रहा है…",
      es: "Comprobando el servidor de desarrollo…",
      fr: "Vérification du serveur de dev…",
      ar: "جارٍ التحقق من خادم التطوير…",
      bn: "ডেভ সার্ভার দেখা হচ্ছে…",
      pt: "Verificando o servidor de desenvolvimento…",
      ru: "Проверяем сервер разработки…",
      ur: "ڈیو سرور چیک ہو رہا ہے…",
      id: "Memeriksa server dev…",
      de: "Dev-Server wird geprüft…",
      ja: "開発サーバーを確認中…",
      sw: "Inakagua seva ya maendeleo…",
      mr: "डेव्ह सर्व्हर तपासत आहे…",
      ko: "개발 서버 확인 중…",
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
      en: "Dev server · production data",
      zh: "开发服务器 · 生产数据",
      hi: "डेव सर्वर · प्रोडक्शन डेटा",
      es: "Servidor de desarrollo · datos de producción",
      fr: "Serveur de dev · données de production",
      ar: "خادم التطوير · بيانات الإنتاج",
      bn: "ডেভ সার্ভার · প্রোডাকশন ডেটা",
      pt: "Servidor de desenvolvimento · dados de produção",
      ru: "Сервер разработки · рабочие данные",
      ur: "ڈیو سرور · پروڈکشن ڈیٹا",
      id: "Server dev · data produksi",
      de: "Dev-Server · Produktionsdaten",
      ja: "開発サーバー · 本番データ",
      sw: "Seva ya maendeleo · data halisi",
      mr: "डेव्ह सर्व्हर · प्रॉडक्शन डेटा",
      ko: "개발 서버 · 운영 데이터",
    }),
  },
};

const context: Record<keyof typeof dictionary.content, string> = {
  open: "Item in the account (profile) dropdown menu, seen only by the site owner: opens the current page on his development server, which reads and writes the real production database. A noun phrase naming the destination; keep the warning in brackets that the data is real.",
  off: "The same menu item, greyed out and not tappable, when the development server is not running. Short statement, not an error message.",
  checking:
    "The same menu item while the menu checks, once, whether the development server is running. Short progress text ending in an ellipsis.",
  back: "Item in the same account menu, on the development server only: returns to the same page on the public site. Imperative phrase; keep lianki.com as is.",
  badge:
    "Small warning label in the top bar of every page of the development server, so the owner never mistakes it for the public site. The data shown is the real production data. Two short noun phrases joined by a middle dot.",
};

export default {
  ...dictionary,
  title: "The owner's dev-server switch in the account menu",
  description: describeKeys(
    "Owner-only: the switch between the public site (lianki.com) and his own development server, which runs his latest code against the real production database. Lianki and lianki.com are names.",
    context,
  ),
} satisfies DeclarationContent;
