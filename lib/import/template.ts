/**
 * The word-list templates (docs/import-material.md, "Templates"): a CSV and
 * an .xlsx with the header row already in the user's language and a few
 * example rows, so a learner fills it in and uploads it without thinking
 * about column names.
 *
 * The header names are data the parser must accept: each one is listed in
 * `HEADER_ALIASES` (unit/import-template.test.ts round-trips every locale:
 * template → parse → the example rows). The example rows are English words
 * with a meaning in the user's language and an English example — what a
 * filled-in row looks like, not a lesson.
 */
import { rowsToCsv, writeXlsx } from "./xlsx";

/** One locale's template: column names (word, meaning, example) and example rows. */
type Template = { header: [string, string, string]; rows: [string, string, string][] };

const EX = {
  apple: "I eat an apple every day.",
  library: "She borrowed two books from the library.",
  brave: "It was brave of him to say sorry.",
};
/** Example rows: the same English words, the meaning in each language. */
const rows = (apple: string, library: string, brave: string): Template["rows"] => [
  ["apple", apple, EX.apple],
  ["library", library, EX.library],
  ["brave", brave, EX.brave],
];

export const TEMPLATES = {
  en: {
    header: ["Word", "Meaning", "Example"],
    rows: rows("a round fruit", "a place to borrow books", "not afraid"),
  },
  zh: { header: ["单词", "释义", "例句"], rows: rows("苹果", "图书馆", "勇敢的") },
  hi: { header: ["शब्द", "अर्थ", "उदाहरण"], rows: rows("सेब", "पुस्तकालय", "बहादुर") },
  es: {
    header: ["Palabra", "Significado", "Ejemplo"],
    rows: rows("manzana", "biblioteca", "valiente"),
  },
  fr: { header: ["Mot", "Sens", "Exemple"], rows: rows("pomme", "bibliothèque", "courageux") },
  ar: { header: ["كلمة", "معنى", "مثال"], rows: rows("تفاحة", "مكتبة", "شجاع") },
  bn: { header: ["শব্দ", "অর্থ", "উদাহরণ"], rows: rows("আপেল", "গ্রন্থাগার", "সাহসী") },
  pt: {
    header: ["Palavra", "Significado", "Exemplo"],
    rows: rows("maçã", "biblioteca", "corajoso"),
  },
  ru: { header: ["Слово", "Значение", "Пример"], rows: rows("яблоко", "библиотека", "смелый") },
  ur: { header: ["لفظ", "معنی", "مثال"], rows: rows("سیب", "کتب خانہ", "بہادر") },
  id: { header: ["Kata", "Arti", "Contoh"], rows: rows("apel", "perpustakaan", "berani") },
  de: {
    header: ["Wort", "Bedeutung", "Beispiel"],
    rows: rows("Apfel", "Bibliothek", "mutig"),
  },
  ja: { header: ["単語", "意味", "例文"], rows: rows("りんご", "図書館", "勇敢な") },
  sw: { header: ["Neno", "Maana", "Mfano"], rows: rows("tufaha", "maktaba", "jasiri") },
  mr: { header: ["शब्द", "अर्थ", "उदाहरण"], rows: rows("सफरचंद", "ग्रंथालय", "धाडसी") },
  ko: { header: ["단어", "뜻", "예문"], rows: rows("사과", "도서관", "용감한") },
} as const satisfies Record<string, Template>;

export type TemplateLocale = keyof typeof TEMPLATES;

/** The template for a UI locale ("zh-CN" → zh); English for one without its own. */
export function templateFor(locale: string): Template {
  const base = locale.toLowerCase().split(/[-_]/)[0];
  return (TEMPLATES as Record<string, Template>)[base] ?? TEMPLATES.en;
}

/** Header row + example rows. */
export const templateRows = (locale: string): string[][] => {
  const t = templateFor(locale);
  return [[...t.header], ...t.rows.map((r) => [...r])];
};

/**
 * The CSV template: UTF-8 with a byte-order mark, so Excel opens Chinese,
 * Arabic or Hindi as text rather than mojibake; CRLF line ends.
 */
export const templateCsv = (locale: string) => `﻿${rowsToCsv(templateRows(locale))}\r\n`;

/** The .xlsx template, one sheet. */
export const templateXlsx = (locale: string) => writeXlsx(templateRows(locale));

/** File names for the downloads: "lianki-words-template.csv" / ".xlsx". */
export const TEMPLATE_FILE = "lianki-words-template";
