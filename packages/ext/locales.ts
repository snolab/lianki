/**
 * The extension's store text in the app's locales, written by
 * scripts/build-extension.ts as `_locales/<locale>/messages.json`, with the
 * manifest's description pointing at it (`__MSG_extDescription__`). The name
 * stays "Lianki" in every locale (a product name), so only the description is
 * localised. Chrome shows it in chrome://extensions and the Web Store listing,
 * in the browser's language.
 *
 * Chrome accepts only its own locale codes: Chinese is zh_CN, Portuguese is
 * pt_BR and pt_PT (one text for both). Urdu (ur) is not one of them, so an Urdu
 * browser gets English there.
 */

/** What every translator reads first (the messages.json `description` field). */
export const EXT_DESCRIPTION_CONTEXT =
  "Short description of the Lianki browser extension, shown under its name in the Chrome Web Store and in the browser's extension list. It reviews web pages and videos as flashcards with spaced repetition (FSRS scheduling). At most 132 characters. Lianki is a product name: keep it as is.";

/** Chrome locale code → the description. `en` is the default_locale. */
export const EXT_DESCRIPTION: Record<string, string> = {
  en: "Spaced repetition for the pages you read and the videos you watch.",
  zh_CN: "为你读过的网页和看过的视频安排间隔复习。",
  ja: "読んだページや見た動画を、間隔反復で復習できます。",
  ko: "읽은 페이지와 본 동영상을 간격 반복으로 복습해요.",
  hi: "आपके पढ़े गए पेज और देखे गए वीडियो के लिए अंतराल दोहराव।",
  es: "Repetición espaciada para las páginas que lees y los vídeos que ves.",
  fr: "La répétition espacée pour les pages que vous lisez et les vidéos que vous regardez.",
  ar: "تكرار متباعد للصفحات التي تقرؤها ومقاطع الفيديو التي تشاهدها.",
  bn: "আপনার পড়া পেজ আর দেখা ভিডিওর জন্য ব্যবধানভিত্তিক পুনরাবৃত্তি।",
  pt_BR: "Repetição espaçada para as páginas que você lê e os vídeos que assiste.",
  pt_PT: "Repetição espaçada para as páginas que você lê e os vídeos que assiste.",
  ru: "Интервальные повторения для страниц, которые вы читаете, и видео, которые смотрите.",
  id: "Pengulangan berjarak untuk halaman yang Anda baca dan video yang Anda tonton.",
  de: "Verteilte Wiederholung für die Seiten, die du liest, und die Videos, die du schaust.",
  sw: "Marudio ya vipindi kwa kurasa unazosoma na video unazotazama.",
  mr: "तुम्ही वाचलेली पाने आणि पाहिलेले व्हिडिओ अंतराने उजळणीसाठी.",
};
