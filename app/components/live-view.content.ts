import { t, type DeclarationContent } from "intlayer";
import { describeKeys } from "@/lib/i18n-context";

/**
 * Live view (docs/live-view.md), called "Dev parts" in the UI: the owner's
 * chip in the account menu's "Preview build" row and
 * the banner at the top of the page while his dev machine's code is loaded.
 * Only the site owner ever sees these strings.
 */
const dictionary = {
  key: "live-view",
  content: {
    liveView: t({
      en: "Dev parts",
      zh: "开发版部件",
      hi: "डेव पार्ट्स",
      es: "Piezas de desarrollo",
      fr: "Éléments de dev",
      ar: "أجزاء التطوير",
      bn: "ডেভ অংশ",
      pt: "Peças de desenvolvimento",
      ru: "Части из разработки",
      ur: "ڈیو حصے",
      id: "Bagian dev",
      de: "Dev-Teile",
      ja: "開発版パーツ",
      sw: "Sehemu za usanidi",
      mr: "डेव्ह भाग",
      ko: "개발 부품",
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
    "Name of a developer mode, as a short noun phrase: the page stays the public site, but some parts of it (a chat widget, some components) load the developer's unreleased code from his own computer. Shown on a small on/off chip inside the 'Preview build' row of the account menu ('Dev parts · branch@commit'), and at the start of the top banner while it is on. Must not repeat the word used for 'Preview build' (a different thing: the whole site's trial version). 'Parts' = pieces of the page, not spare parts.",
  normal:
    "Button on the Dev parts top banner that turns the mode off and goes back to the ordinary released site. One word, an adjective naming the view.",
  waiting:
    "Status text after '·' on the Dev parts chip in the account menu, when the chip is on but the developer's computer has not shared any code yet. A short status phrase, no full stop.",
  refused:
    "Status text after '·' on the Dev parts chip in the account menu, when the page rejected the developer's code pointer because its signature or date did not check out; a technical reason follows in parentheses. Short status phrase; 'pointer' means a reference to where the code is.",
};

export default {
  ...dictionary,
  title: "Live view (Dev parts) — the owner's chip to load his dev machine's code",
  description: describeKeys(
    "The account-menu chip and the top banner of Live view (shown as 'Dev parts'), a mode only the site owner sees: the page stays the same, but some of its code comes from his development computer. Keep branch names and commit ids as they are.",
    context,
  ),
} satisfies DeclarationContent;
