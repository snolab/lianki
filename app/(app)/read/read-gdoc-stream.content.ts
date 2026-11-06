import { t, type DeclarationContent } from "intlayer";
import { describeKeys } from "@/lib/i18n-context";

/** /read/<id>?streamingFrom=google-docs: the book follows a Google Doc as it is edited. */
const dictionary = {
  key: "read-gdoc-stream",
  content: {
    live: t({
      en: "Live from Google Docs",
      zh: "正在从 Google 文档实时同步",
      hi: "Google Docs से लाइव",
      es: "En directo desde Google Docs",
      fr: "En direct depuis Google Docs",
      ar: "مباشر من مستندات Google",
      bn: "Google Docs থেকে লাইভ",
      pt: "Ao vivo do Google Docs",
      ru: "В реальном времени из Google Документов",
      ur: "Google Docs سے براہ راست",
      id: "Langsung dari Google Dokumen",
      de: "Live aus Google Docs",
      ja: "Google ドキュメントからライブ同期中",
      sw: "Moja kwa moja kutoka Google Docs",
      mr: "Google Docs वरून थेट",
      ko: "Google 문서에서 실시간 동기화 중",
    }),
    offline: t({
      en: "Reconnecting to the live doc…",
      zh: "正在重新连接实时文档…",
      hi: "लाइव दस्तावेज़ से फिर जुड़ रहा है…",
      es: "Reconectando con el documento en directo…",
      fr: "Reconnexion au document en direct…",
      ar: "جارٍ إعادة الاتصال بالمستند المباشر…",
      bn: "লাইভ ডকের সাথে আবার সংযোগ হচ্ছে…",
      pt: "Reconectando ao documento ao vivo…",
      ru: "Переподключение к документу…",
      ur: "براہ راست دستاویز سے دوبارہ جڑ رہا ہے…",
      id: "Menghubungkan kembali ke dokumen langsung…",
      de: "Verbindung zum Live-Dokument wird wiederhergestellt…",
      ja: "ライブ文書に再接続しています…",
      sw: "Inaunganisha tena na hati ya moja kwa moja…",
      mr: "थेट दस्तऐवजाशी पुन्हा जोडत आहे…",
      ko: "실시간 문서에 다시 연결하는 중…",
    }),
  },
};

const context = {
  live: "Small status pill at the top of the reader while the book is following a Google Doc: the text on screen updates as the doc is edited.",
  offline:
    "The same pill when the connection that brings live updates dropped and is being retried; the text on screen stays readable but may be behind.",
};

export default {
  ...dictionary,
  title: "/read — a book following a live Google Doc",
  description: describeKeys(
    "The status pill on the reader page while it is streaming from a Google Doc.",
    context,
  ),
} satisfies DeclarationContent;
