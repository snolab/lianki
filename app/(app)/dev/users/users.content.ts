import { t, type DeclarationContent } from "intlayer";
import { describeKeys } from "@/lib/i18n-context";

/**
 * /dev/users (app/(app)/dev/users): the internal table of every account with
 * its membership, activity and how much data it holds. Read by the site's
 * administrators only. Column headings are sortable buttons and must stay short.
 */
const dictionary = {
  key: "dev-users",
  content: {
    dbText: t({
      en: "DB text",
      zh: "库内文本",
      hi: "DB टेक्स्ट",
      es: "Texto BD",
      fr: "Texte BD",
      ar: "نص القاعدة",
      bn: "DB টেক্সট",
      pt: "Texto BD",
      ru: "Текст БД",
      ur: "DB متن",
      id: "Teks DB",
      de: "DB-Text",
      ja: "DBテキスト",
      sw: "Maandishi DB",
      mr: "DB मजकूर",
      ko: "DB 텍스트",
    }),
    files: t({
      en: "Files",
      zh: "文件",
      hi: "फ़ाइलें",
      es: "Archivos",
      fr: "Fichiers",
      ar: "الملفات",
      bn: "ফাইল",
      pt: "Arquivos",
      ru: "Файлы",
      ur: "فائلیں",
      id: "Berkas",
      de: "Dateien",
      ja: "ファイル",
      sw: "Faili",
      mr: "फाइल्स",
      ko: "파일",
    }),
    dbTextTotal: t({
      en: "DB text, total",
      zh: "库内文本总量",
      hi: "कुल DB टेक्स्ट",
      es: "Texto BD, total",
      fr: "Texte BD, total",
      ar: "إجمالي نص القاعدة",
      bn: "মোট DB টেক্সট",
      pt: "Texto BD, total",
      ru: "Текст БД, всего",
      ur: "کل DB متن",
      id: "Total teks DB",
      de: "DB-Text gesamt",
      ja: "DBテキスト合計",
      sw: "Jumla ya maandishi DB",
      mr: "एकूण DB मजकूर",
      ko: "DB 텍스트 합계",
    }),
    filesTotal: t({
      en: "Files, total",
      zh: "文件总量",
      hi: "कुल फ़ाइलें",
      es: "Archivos, total",
      fr: "Fichiers, total",
      ar: "إجمالي الملفات",
      bn: "মোট ফাইল",
      pt: "Arquivos, total",
      ru: "Файлы, всего",
      ur: "کل فائلیں",
      id: "Total berkas",
      de: "Dateien gesamt",
      ja: "ファイル合計",
      sw: "Jumla ya faili",
      mr: "एकूण फाइल्स",
      ko: "파일 합계",
    }),
    inboxCap: t({
      en: "inbox {used} / {limit}",
      zh: "收件箱 {used} / {limit}",
      hi: "इनबॉक्स {used} / {limit}",
      es: "bandeja {used} / {limit}",
      fr: "boîte {used} / {limit}",
      ar: "الوارد {used} / {limit}",
      bn: "ইনবক্স {used} / {limit}",
      pt: "caixa {used} / {limit}",
      ru: "входящие {used} / {limit}",
      ur: "ان باکس {used} / {limit}",
      id: "kotak masuk {used} / {limit}",
      de: "Eingang {used} / {limit}",
      ja: "受信箱 {used} / {limit}",
      sw: "kikasha {used} / {limit}",
      mr: "इनबॉक्स {used} / {limit}",
      ko: "받은함 {used} / {limit}",
    }),
  },
};

const context: Record<keyof typeof dictionary.content, string> = {
  dbText:
    "Short sortable column heading in the accounts table: the estimated size of the account's text stored in the database rows (cards, logs, word lists). A noun phrase; keep 'DB' short.",
  files:
    "Short sortable column heading in the accounts table: bytes of the account's stored files (uploads, profile picture, long reading texts) in cloud storage. One plural noun.",
  dbTextTotal:
    "Label of a small summary box above the accounts table: the database text size of all accounts added together. A short noun phrase.",
  filesTotal:
    "Label of a small summary box above the accounts table: the stored file bytes of all accounts added together. A short noun phrase.",
  inboxCap:
    "Small grey line under an account's file size: how much of the chat inbox's storage cap the account uses. {used} and {limit} are sizes like '3 MB' and '2 GB'; keep both placeholders and the slash.",
};

export default {
  ...dictionary,
  title: "/dev/users — every account with its usage",
  description: describeKeys(
    "The internal accounts table: membership, activity, database text and stored file sizes per account, with totals. Read by site administrators only; plain and very short labels.",
    context,
  ),
} satisfies DeclarationContent;
