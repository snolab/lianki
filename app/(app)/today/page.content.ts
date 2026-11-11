import { t, type DeclarationContent } from "intlayer";
import { describeKeys } from "../../../lib/i18n-context";

/**
 * /today, today's goal (TodayClient.tsx, lib/today/goal.ts): a full-screen page
 * with one number, the cards left today, a progress bar and a Start button.
 * Every key has a line in `context` below (docs/i18n.md).
 */
const dictionary = {
  key: "today-page",
  content: {
    title: t({
      en: "Today's goal",
      zh: "今日目标",
      hi: "आज का लक्ष्य",
      es: "Meta de hoy",
      fr: "Objectif du jour",
      ar: "هدف اليوم",
      bn: "আজকের লক্ষ্য",
      pt: "Meta de hoje",
      ru: "Цель на сегодня",
      ur: "آج کا ہدف",
      id: "Target hari ini",
      de: "Heutiges Ziel",
      ja: "今日の目標",
      sw: "Lengo la leo",
      mr: "आजचे ध्येय",
      ko: "오늘의 목표",
    }),
    leftOne: t({
      en: "{count} card left",
      zh: "还剩 {count} 张卡片",
      hi: "{count} कार्ड बाकी",
      es: "Queda {count} tarjeta",
      fr: "Encore {count} carte",
      ar: "متبقٍّ: {count} بطاقة",
      bn: "আর {count}টি কার্ড বাকি",
      pt: "Falta {count} cartão",
      ru: "Осталось карточек: {count}",
      ur: "{count} کارڈ باقی",
      id: "Sisa {count} kartu",
      de: "Noch {count} Karte",
      ja: "残り {count} 枚",
      sw: "Imebaki kadi {count}",
      mr: "{count} कार्ड बाकी",
      ko: "남은 카드 {count}장",
    }),
    leftOther: t({
      en: "{count} cards left",
      zh: "还剩 {count} 张卡片",
      hi: "{count} कार्ड बाकी",
      es: "Quedan {count} tarjetas",
      fr: "Encore {count} cartes",
      ar: "متبقٍّ: {count} بطاقات",
      bn: "আর {count}টি কার্ড বাকি",
      pt: "Faltam {count} cartões",
      ru: "Осталось карточек: {count}",
      ur: "{count} کارڈ باقی",
      id: "Sisa {count} kartu",
      de: "Noch {count} Karten",
      ja: "残り {count} 枚",
      sw: "Zimebaki kadi {count}",
      mr: "{count} कार्डे बाकी",
      ko: "남은 카드 {count}장",
    }),
    allDone: t({
      en: "All done for today",
      zh: "今天的卡片都完成了",
      hi: "आज के सारे कार्ड हो गए",
      es: "Todo listo por hoy",
      fr: "Tout est fait pour aujourd'hui",
      ar: "انتهيت من بطاقات اليوم",
      bn: "আজকের সব কার্ড শেষ",
      pt: "Tudo feito por hoje",
      ru: "На сегодня всё",
      ur: "آج کے سب کارڈ ہو گئے",
      id: "Semua selesai untuk hari ini",
      de: "Für heute alles erledigt",
      ja: "今日の分はすべて完了",
      sw: "Umemaliza zote za leo",
      mr: "आजची सर्व कार्डे झाली",
      ko: "오늘 분량을 모두 마쳤어요",
    }),
    progress: t({
      en: "Today's progress",
      zh: "今日进度",
      hi: "आज की प्रगति",
      es: "Progreso de hoy",
      fr: "Progression du jour",
      ar: "تقدّم اليوم",
      bn: "আজকের অগ্রগতি",
      pt: "Progresso de hoje",
      ru: "Прогресс за сегодня",
      ur: "آج کی پیش رفت",
      id: "Kemajuan hari ini",
      de: "Heutiger Fortschritt",
      ja: "今日の進み具合",
      sw: "Maendeleo ya leo",
      mr: "आजची प्रगती",
      ko: "오늘의 진행",
    }),
    start: t({
      en: "Start",
      zh: "开始",
      hi: "शुरू करें",
      es: "Empezar",
      fr: "Commencer",
      ar: "ابدأ",
      bn: "শুরু করুন",
      pt: "Começar",
      ru: "Начать",
      ur: "شروع کریں",
      id: "Mulai",
      de: "Los geht's",
      ja: "はじめる",
      sw: "Anza",
      mr: "सुरू करा",
      ko: "시작",
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
  title:
    "/today, a full-screen page: the large brush-lettered heading, the learner's study goal for the current day. Also the sidebar and home link name. A short noun phrase, no final punctuation.",
  leftOne:
    "/today: the page's only number, under the heading: how many review cards are still left to study today, when that number is exactly one (plural rules pick this or leftOther). {count} is the number. A short phrase; keep the placeholder.",
  leftOther:
    "/today: the page's only number, under the heading: how many review cards are still left to study today, for any count other than one (plural rules pick this or leftOne). {count} is the number. A short phrase; keep the placeholder.",
  allDone:
    "/today: shown instead of the cards-left line when no card is left to study today. A short, warm statement, no exclamation mark needed.",
  progress:
    "/today: screen-reader name of the progress bar under the number: the share of today's cards already studied. A short noun phrase.",
  start:
    "/today: the big button at the bottom that opens the word list study page to study the cards left. One imperative verb on a button.",
  close:
    "/today: screen-reader label of the ✕ in the top corner that leaves the full-screen page. An imperative verb.",
};

const todayPageContent = {
  ...dictionary,
  title: "/today — today's goal",
  description: describeKeys(
    "Strings for /today in Lianki, a spaced-repetition app for learning languages: a full-screen page in seal red and gold showing the learner's goal for the day — one number (the cards left today), a progress bar and a Start button that opens the word lists. Keep them as short as the English.",
    context,
  ),
} satisfies DeclarationContent;

export default todayPageContent;
