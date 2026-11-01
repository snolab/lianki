import { t, type DeclarationContent } from "intlayer";
import { describeKeys } from "@/lib/i18n-context";

/**
 * Live view (docs/live-view.md): the owner's switch in the account menu and
 * the banner at the top of the page while his dev machine's code is loaded.
 * Only the site owner ever sees these strings.
 */
const dictionary = {
  key: "live-view",
  content: {
    liveView: t({
      en: "Live view",
      zh: "实时预览",
      hi: "लाइव व्यू",
      es: "Vista en vivo",
      fr: "Vue en direct",
      ar: "العرض المباشر",
      bn: "লাইভ ভিউ",
      pt: "Visualização ao vivo",
      ru: "Живой просмотр",
      ur: "لائیو ویو",
      id: "Tampilan langsung",
      de: "Live-Ansicht",
      ja: "ライブビュー",
      sw: "Mwonekano wa moja kwa moja",
      mr: "लाइव्ह व्ह्यू",
      ko: "라이브 뷰",
    }),
    normal: t({
      en: "Normal",
      zh: "正常",
      hi: "सामान्य",
      es: "Normal",
      fr: "Normal",
      ar: "عادي",
      bn: "সাধারণ",
      pt: "Normal",
      ru: "Обычный",
      ur: "عام",
      id: "Normal",
      de: "Normal",
      ja: "通常",
      sw: "Kawaida",
      mr: "सामान्य",
      ko: "일반",
    }),
    waiting: t({
      en: "Waiting for the dev machine",
      zh: "等待开发机",
      hi: "डेवलपमेंट मशीन की प्रतीक्षा",
      es: "Esperando la máquina de desarrollo",
      fr: "En attente de la machine de dev",
      ar: "بانتظار جهاز التطوير",
      bn: "ডেভেলপমেন্ট মেশিনের অপেক্ষায়",
      pt: "Aguardando a máquina de desenvolvimento",
      ru: "Ожидание машины разработчика",
      ur: "ڈیولپمنٹ مشین کا انتظار",
      id: "Menunggu mesin pengembang",
      de: "Wartet auf den Entwicklungsrechner",
      ja: "開発マシンを待っています",
      sw: "Inasubiri mashine ya usanidi",
      mr: "डेव्हलपमेंट मशीनची प्रतीक्षा",
      ko: "개발 머신 대기 중",
    }),
    refused: t({
      en: "Pointer refused",
      zh: "指针被拒绝",
      hi: "पॉइंटर अस्वीकृत",
      es: "Puntero rechazado",
      fr: "Pointeur refusé",
      ar: "تم رفض المؤشر",
      bn: "পয়েন্টার প্রত্যাখ্যাত",
      pt: "Ponteiro recusado",
      ru: "Указатель отклонён",
      ur: "پوائنٹر مسترد",
      id: "Penunjuk ditolak",
      de: "Zeiger abgelehnt",
      ja: "ポインタを拒否しました",
      sw: "Kielekezi kimekataliwa",
      mr: "पॉइंटर नाकारला",
      ko: "포인터 거부됨",
    }),
  },
};

const context: Record<keyof typeof dictionary.content, string> = {
  liveView:
    "Name of a developer mode, as a short noun phrase: the page loads the developer's unreleased code from his own computer. Shown on an on/off switch in the account menu and at the start of the top banner ('Live view · branch@commit'). Not 'live broadcast'.",
  normal:
    "Name of the opposite mode: the ordinary released site. Shown after ⇄ on the same menu switch ('Live view ⇄ Normal') and on the banner's button that goes back to it. One word, an adjective naming the view.",
  waiting:
    "Small grey line under the Live view switch when it is on but the developer's computer has not shared any code yet. A short status phrase, no full stop.",
  refused:
    "Small line under the Live view switch when the page rejected the developer's code pointer because its signature or date did not check out; a technical reason follows in parentheses. Short status phrase; 'pointer' means a reference to where the code is.",
};

export default {
  ...dictionary,
  title: "Live view — the owner's switch to load his dev machine's code",
  description: describeKeys(
    "The account-menu switch and the top banner of Live view, a mode only the site owner sees: the page stays the same, but some of its code comes from his development computer. Keep ⇄, branch names and commit ids as they are.",
    context,
  ),
} satisfies DeclarationContent;
