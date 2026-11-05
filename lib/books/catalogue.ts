// The shared public-domain catalogue shown at /books (docs/books-plan.md,
// "The catalogue: /books"). Data only: one entry per edition, in any
// language; one importer for all of them, no per-language code.
//
// Book texts are never in the repo. Each entry names the exact file the server
// fetches on demand (lib/books/source.ts), from one of SOURCE_HOSTS only; the
// fetched file is cached in R2 (`lianki-blobs`, `preset-cache/`) and shared by
// every user after the first import.
//
// The admission rule (lib/books/terms.ts; docs/books-plan.md, "Admission
// rule"): a book is shown to a viewer only when it is public domain in its
// country of first publication, in the viewer's country and in the US, judged
// from every creator of the edition (author, translator, editor, illustrator,
// author of an introduction). checkCatalogue (unit/books-catalogue.test.ts)
// requires every entry to carry that data and to pass in its own country and
// in the US; /books and the import filter per viewer. Not legal advice.
// Original-language texts. Death years and first-publication years were
// checked on each Project Gutenberg ebook page (its author line gives the
// dates) and standard references (Wikipedia, BnF data) on 2026-11-05.
//
// Client-safe (no server imports): /books renders from it.

import { SLUG_RE, slugOf } from "./slug";
import { TERMS, normaliseCountry, pdForViewer, pdIn, type Creator } from "./terms";

/** Hosts the server may fetch a catalogue file from, and follow a redirect to. */
export const SOURCE_HOSTS = [
  "www.gutenberg.org",
  "www.aozora.gr.jp",
  "zh.wikisource.org",
  "ru.wikisource.org",
] as const;

/**
 * The kinds of source file the importer reads (lib/books/source.ts), one per
 * host format: a Project Gutenberg HTML ebook, an Aozora Bunko XHTML file, a
 * Wikisource page's REST HTML (`/api/rest_v1/page/html/<title>/<revision>`).
 */
export type SourceFormat = "gutenberg-html" | "aozora-xhtml" | "wikisource-html";

export interface CatalogueBook {
  /**
   * The book's stable slug within its language: /books/<lang>/<slug>, and the
   * import's source key `preset:<lang>/<slug>`. Written once (by hand for
   * curated entries, lib/books/slug.ts for others), never recomputed or reused.
   */
  slug: string;
  title: string;
  /** As the source credits them. */
  author: string;
  /** BCP 47 language of the text. */
  lang: string;
  /** CEFR level hint, data only ("A1", "A2–B1"). */
  level: string;
  /** Verse or prose: shown beside the level. */
  form?: "verse" | "prose";
  /** ISO 3166-1 alpha-2 of the country where the work was first published. */
  workCountry: string;
  /** Year of the work's first publication (the US publication rule). */
  firstPublicationYear: number;
  /**
   * Every creator of this edition with the year they died (author,
   * translator, editor, illustrator, introduction): the life+N terms.
   */
  creators: Creator[];
  source: {
    /** The human page that names the edition and its licence: linked on the card and in the book. */
    page: string;
    /** The one file the server fetches (an export the importer parses). */
    file: string;
    format: SourceFormat;
    /** The site, as shown ("Project Gutenberg"). */
    name: string;
  };
  /** Licence line shown on the card and in the imported book. */
  licence: string;
  /** Attribution shown on the card and in the imported book. */
  attribution: string;
  /**
   * Only part of the file, for an edition that carries matter we do not want
   * (a long introduction in another language): from the element with id
   * `from`, up to the element with id `to` or the first `toMarkup` after it.
   */
  range?: { from?: string; to?: string; toMarkup?: string };
}

const PG_LICENCE =
  "Public domain in the USA. Distributed under the Project Gutenberg License (www.gutenberg.org/policy/license.html).";
const pg = (n: number) => ({
  page: `https://www.gutenberg.org/ebooks/${n}`,
  file: `https://www.gutenberg.org/cache/epub/${n}/pg${n}-images.html`,
  format: "gutenberg-html" as const,
  name: "Project Gutenberg",
});
const pgCredit = (n: number) =>
  `Project Gutenberg eBook #${n} (www.gutenberg.org), transcribed by its volunteers.`;

const AOZORA_LICENCE =
  "Public domain (著作権保護期間満了). Aozora Bunko (www.aozora.gr.jp) asks that its input and proofreading volunteers be credited.";
/** An Aozora Bunko work: its card (the human page) and its XHTML file, both under cards/<author>/. */
const aozora = (author: string, card: number, file: string) => ({
  page: `https://www.aozora.gr.jp/cards/${author}/card${card}.html`,
  file: `https://www.aozora.gr.jp/cards/${author}/files/${file}.html`,
  format: "aozora-xhtml" as const,
  name: "青空文庫 Aozora Bunko",
});
/** Aozora's own credit line: the printed edition it was typed from, and its volunteers. */
const aozoraCredit = (base: string, people: string) =>
  `青空文庫 (www.aozora.gr.jp)。底本：${base}。${people}。`;

const WIKISOURCE_LICENCE =
  "Public domain (the work). Wikisource's transcription is shared under CC BY-SA 4.0 (creativecommons.org/licenses/by-sa/4.0).";
/** A Wikisource page, pinned to one revision: the edition does not change under the cache. */
const wikisource = (host: string, title: string, revision: number) => {
  const t = title.replace(/ /g, "_");
  return {
    page: `https://${host}/wiki/${encodeURI(t)}`,
    file: `https://${host}/api/rest_v1/page/html/${encodeURIComponent(t)}/${revision}`,
    format: "wikisource-html" as const,
    name: "Wikisource",
  };
};
const wsCredit = (host: string, title: string, revision: number) =>
  `Wikisource (${host}), "${title}", revision ${revision}, transcribed by its contributors.`;

export const CATALOGUE: CatalogueBook[] = [
  {
    slug: "histoires-ou-contes-du-temps-passé",
    title: "Histoires ou Contes du temps passé",
    author: "Charles Perrault",
    lang: "fr",
    level: "A1",
    form: "prose",
    // Paris, Claude Barbin, 1697. PG #33931: Perrault 1628–1703, Lang 1844–1912.
    workCountry: "FR",
    firstPublicationYear: 1697,
    // Andrew Lang's 1888 Oxford edition; only the 1697 prose tales are
    // imported (`range`), not his English introduction and notes.
    creators: [
      { name: "Charles Perrault", role: "author", deathYear: 1703 },
      { name: "Andrew Lang", role: "editor", deathYear: 1912 },
    ],
    source: pg(33931),
    licence: PG_LICENCE,
    attribution: `${pgCredit(33931)} The 1697 text, from Perrault's Popular Tales, ed. Andrew Lang (Oxford, 1888).`,
    range: { from: "belle", toMarkup: "<i>Extrait du Privil" },
  },
  {
    slug: "fables-livre-i",
    title: "Fables, livre I",
    author: "Jean de La Fontaine",
    lang: "fr",
    level: "A1–A2",
    form: "verse",
    // Paris, Barbin / Thierry, 1668 (books I–VI). PG #17941: La Fontaine 1621–1695.
    workCountry: "FR",
    firstPublicationYear: 1668,
    creators: [{ name: "Jean de La Fontaine", role: "author", deathYear: 1695 }],
    source: pg(17941),
    licence: PG_LICENCE,
    attribution: pgCredit(17941),
  },
  {
    slug: "lettres-de-mon-moulin",
    title: "Lettres de mon moulin",
    author: "Alphonse Daudet",
    lang: "fr",
    level: "A2",
    form: "prose",
    // Paris, Hetzel, 1869 (some letters ran in L'Événement from 1866; the
    // earlier year changes no result). PG #11770: Daudet 1840–1897.
    workCountry: "FR",
    firstPublicationYear: 1869,
    // Not #36780: its introduction is by Charles Sarolea (died 1953).
    creators: [{ name: "Alphonse Daudet", role: "author", deathYear: 1897 }],
    source: pg(11770),
    licence: PG_LICENCE,
    attribution: pgCredit(11770),
  },
  {
    slug: "contes-du-jour-et-de-la-nuit",
    title: "Contes du jour et de la nuit",
    author: "Guy de Maupassant",
    lang: "fr",
    level: "A2–B1",
    form: "prose",
    // Paris, Marpon & Flammarion, 1885. PG #14790: Maupassant 1850–1893.
    workCountry: "FR",
    firstPublicationYear: 1885,
    // Includes "La Parure". Illustrations (not imported) by Paul Cousturier
    // (b. 1855, also "Paul de Sémant"): references give his death as 1908
    // (bedetheque) or 1915 (Wikipedia); the later year is kept.
    creators: [
      { name: "Guy de Maupassant", role: "author", deathYear: 1893 },
      { name: "Paul Cousturier", role: "illustrator", deathYear: 1915 },
    ],
    source: pg(14790),
    licence: PG_LICENCE,
    attribution: pgCredit(14790),
    // From the first tale: the title pages carry the publisher's list of other books.
    range: { from: "LE_CRIME_AU_PERE_BONIFACE" },
  },
  {
    slug: "candide-ou-l'optimisme",
    title: "Candide, ou l'optimisme",
    author: "Voltaire",
    lang: "fr",
    level: "B1",
    form: "prose",
    // Geneva, Cramer, January 1759 (Paris and Amsterdam printings the same
    // month). PG #4650: Voltaire 1694–1778; Beuchot 1777–1851 (BnF).
    workCountry: "CH",
    firstPublicationYear: 1759,
    // Beuchot's edition of the Œuvres (Lefèvre / Firmin Didot, 1829), with his preface and notes.
    creators: [
      { name: "Voltaire", role: "author", deathYear: 1778 },
      { name: "Adrien Beuchot", role: "editor", deathYear: 1851 },
    ],
    source: pg(4650),
    licence: PG_LICENCE,
    attribution: pgCredit(4650),
  },
  {
    slug: "alice's-adventures-in-wonderland",
    title: "Alice's Adventures in Wonderland",
    author: "Lewis Carroll",
    lang: "en",
    level: "A2–B1",
    form: "prose",
    // London, Macmillan, 1865. PG #11: Carroll 1832–1898.
    workCountry: "GB",
    firstPublicationYear: 1865,
    creators: [{ name: "Lewis Carroll", role: "author", deathYear: 1898 }],
    source: pg(11),
    licence: PG_LICENCE,
    attribution: pgCredit(11),
  },
  {
    slug: "die-verwandlung",
    title: "Die Verwandlung",
    author: "Franz Kafka",
    lang: "de",
    level: "B1",
    form: "prose",
    // Leipzig: Die weißen Blätter, October 1915, then Kurt Wolff, 1915.
    // PG #22367: Kafka 1883–1924.
    workCountry: "DE",
    firstPublicationYear: 1915,
    creators: [{ name: "Franz Kafka", role: "author", deathYear: 1924 }],
    source: pg(22367),
    licence: PG_LICENCE,
    attribution: pgCredit(22367),
  },

  // ── English ──────────────────────────────────────────────────────────────
  {
    slug: "the-tale-of-peter-rabbit",
    title: "The Tale of Peter Rabbit",
    author: "Beatrix Potter",
    lang: "en",
    level: "A1",
    form: "prose",
    // London, Frederick Warne, October 1902 (privately printed 1901; the
    // later year changes no result). PG #14838: Potter 1866–1943, who also
    // drew the pictures (not imported).
    workCountry: "GB",
    firstPublicationYear: 1902,
    creators: [{ name: "Beatrix Potter", role: "author", deathYear: 1943 }],
    source: pg(14838),
    licence: PG_LICENCE,
    attribution: pgCredit(14838),
  },
  {
    slug: "the-happy-prince-and-other-tales",
    title: "The Happy Prince and Other Tales",
    author: "Oscar Wilde",
    lang: "en",
    level: "A2–B1",
    form: "prose",
    // London, David Nutt, 1888. PG #902: Wilde 1854–1900; no illustrations
    // in this file (the 1888 pictures by Crane and Hood are not in it).
    workCountry: "GB",
    firstPublicationYear: 1888,
    creators: [{ name: "Oscar Wilde", role: "author", deathYear: 1900 }],
    source: pg(902),
    licence: PG_LICENCE,
    attribution: pgCredit(902),
  },
  {
    slug: "just-so-stories",
    title: "Just So Stories",
    author: "Rudyard Kipling",
    lang: "en",
    level: "A2–B1",
    form: "prose",
    // London, Macmillan, 1902. PG #2781: Kipling 1865–1936 (his own
    // illustrations are not in this file).
    workCountry: "GB",
    firstPublicationYear: 1902,
    creators: [{ name: "Rudyard Kipling", role: "author", deathYear: 1936 }],
    source: pg(2781),
    licence: PG_LICENCE,
    attribution: pgCredit(2781),
  },
  {
    slug: "the-wonderful-wizard-of-oz",
    title: "The Wonderful Wizard of Oz",
    author: "L. Frank Baum",
    lang: "en",
    level: "A2–B1",
    form: "prose",
    // Chicago, George M. Hill, 1900. PG #55: Baum 1856–1919. W. W. Denslow
    // (1856–1915) illustrated the first edition; kept as a creator although
    // this file has no pictures.
    workCountry: "US",
    firstPublicationYear: 1900,
    creators: [
      { name: "L. Frank Baum", role: "author", deathYear: 1919 },
      { name: "W. W. Denslow", role: "illustrator", deathYear: 1915 },
    ],
    source: pg(55),
    licence: PG_LICENCE,
    attribution: pgCredit(55),
  },

  // ── German ───────────────────────────────────────────────────────────────
  {
    slug: "der-struwwelpeter",
    title: "Der Struwwelpeter",
    author: "Heinrich Hoffmann",
    lang: "de",
    level: "A1–A2",
    form: "verse",
    // Frankfurt am Main, Literarische Anstalt, 1845 (as "Lustige Geschichten
    // und drollige Bilder"). PG #24571: Hoffmann 1809–1894, author and illustrator.
    workCountry: "DE",
    firstPublicationYear: 1845,
    creators: [{ name: "Heinrich Hoffmann", role: "author", deathYear: 1894 }],
    source: pg(24571),
    licence: PG_LICENCE,
    attribution: pgCredit(24571),
  },
  {
    slug: "max-und-moritz",
    title: "Max und Moritz",
    author: "Wilhelm Busch",
    lang: "de",
    level: "A2",
    form: "verse",
    // München, Braun & Schneider, 1865. PG #17161: Busch 1832–1908, author and illustrator.
    workCountry: "DE",
    firstPublicationYear: 1865,
    creators: [{ name: "Wilhelm Busch", role: "author", deathYear: 1908 }],
    source: pg(17161),
    licence: PG_LICENCE,
    attribution: pgCredit(17161),
    // From the preface: the file opens with transcriber's notes.
    range: { from: "Vorwort" },
  },
  {
    slug: "aus-dem-leben-eines-taugenichts",
    title: "Aus dem Leben eines Taugenichts",
    author: "Joseph von Eichendorff",
    lang: "de",
    level: "B1",
    form: "prose",
    // Berlin, Vereinsbuchhandlung, 1826. PG #35312: Eichendorff 1788–1857.
    workCountry: "DE",
    firstPublicationYear: 1826,
    creators: [{ name: "Joseph von Eichendorff", role: "author", deathYear: 1857 }],
    source: pg(35312),
    licence: PG_LICENCE,
    attribution: pgCredit(35312),
    // Without the transcriber's notes before and the list of corrections after.
    range: { from: "coverpage", to: "tnote-bottom" },
  },

  // ── Spanish ──────────────────────────────────────────────────────────────
  {
    slug: "cuentos-de-amor",
    title: "Cuentos de amor",
    author: "Emilia Pardo Bazán",
    lang: "es",
    level: "B1",
    form: "prose",
    // Madrid, 1898 (Obras completas). PG #55514: Pardo Bazán 1851–1921.
    workCountry: "ES",
    firstPublicationYear: 1898,
    creators: [{ name: "Emilia Pardo Bazán", role: "author", deathYear: 1921 }],
    source: pg(55514),
    licence: PG_LICENCE,
    attribution: pgCredit(55514),
  },
  {
    slug: "niebla",
    title: "Niebla",
    author: "Miguel de Unamuno",
    lang: "es",
    level: "B2",
    form: "prose",
    // Madrid, Renacimiento, 1914. PG #49836: Unamuno 1864–1936 (Spain's
    // life+80 for a creator who died by 1987: free since 2017).
    workCountry: "ES",
    firstPublicationYear: 1914,
    creators: [{ name: "Miguel de Unamuno", role: "author", deathYear: 1936 }],
    source: pg(49836),
    licence: PG_LICENCE,
    attribution: pgCredit(49836),
    // Up to the transcriber's note at the end.
    range: { to: "tnote" },
  },

  // ── Italian ──────────────────────────────────────────────────────────────
  {
    slug: "le-avventure-di-pinocchio",
    title: "Le avventure di Pinocchio",
    author: "Carlo Collodi",
    lang: "it",
    level: "A2–B1",
    form: "prose",
    // Firenze, Felice Paggi, 1883 (serialised 1881–1883). PG #52484: Collodi
    // 1826–1890; this is Bemporad's edition illustrated by Carlo Chiostri (1863–1939).
    workCountry: "IT",
    firstPublicationYear: 1883,
    creators: [
      { name: "Carlo Collodi", role: "author", deathYear: 1890 },
      { name: "Carlo Chiostri", role: "illustrator", deathYear: 1939 },
    ],
    source: pg(52484),
    licence: PG_LICENCE,
    attribution: pgCredit(52484),
    range: { toMarkup: '<div class="tnote">' },
  },
  {
    slug: "novelle",
    title: "Novelle",
    author: "Edmondo De Amicis",
    lang: "it",
    level: "B1",
    form: "prose",
    // Firenze, Le Monnier, 1872. PG #58341 is the Milano, Treves, 1884 edition
    // (its title page): De Amicis 1846–1908; illustrations (not imported) by
    // Vespasiano Bignami (1841–1929).
    workCountry: "IT",
    firstPublicationYear: 1872,
    creators: [
      { name: "Edmondo De Amicis", role: "author", deathYear: 1908 },
      { name: "Vespasiano Bignami", role: "illustrator", deathYear: 1929 },
    ],
    source: pg(58341),
    licence: PG_LICENCE,
    attribution: pgCredit(58341),
    range: { toMarkup: '<div class="tnote">' },
  },
  {
    slug: "inferno",
    title: "Divina Commedia: Inferno",
    author: "Dante Alighieri",
    lang: "it",
    level: "C1",
    form: "verse",
    // First printed at Foligno, 1472 (written c. 1308–1321). PG #997: Dante 1265–1321.
    workCountry: "IT",
    firstPublicationYear: 1472,
    creators: [{ name: "Dante Alighieri", role: "author", deathYear: 1321 }],
    source: pg(997),
    licence: PG_LICENCE,
    attribution: pgCredit(997),
  },

  // ── Portuguese ───────────────────────────────────────────────────────────
  {
    slug: "historias-sem-data",
    title: "Historias Sem Data",
    author: "Machado de Assis",
    lang: "pt",
    level: "B1",
    form: "prose",
    // Rio de Janeiro, Garnier, 1884. PG #33056: Machado de Assis 1839–1908.
    workCountry: "BR",
    firstPublicationYear: 1884,
    creators: [{ name: "Machado de Assis", role: "author", deathYear: 1908 }],
    source: pg(33056),
    licence: PG_LICENCE,
    attribution: pgCredit(33056),
  },
  {
    slug: "contos",
    title: "Contos",
    author: "Eça de Queirós",
    lang: "pt",
    level: "B1",
    form: "prose",
    // Porto, Lello & Irmão / Chardron, 1902 (posthumous, gathered by Luís
    // de Magalhães, 1859–1935). PG #31347: Eça de Queirós 1845–1900.
    workCountry: "PT",
    firstPublicationYear: 1902,
    creators: [
      { name: "Eça de Queirós", role: "author", deathYear: 1900 },
      { name: "Luís de Magalhães", role: "editor", deathYear: 1935 },
    ],
    source: pg(31347),
    licence: PG_LICENCE,
    attribution: pgCredit(31347),
    range: { toMarkup: "<b>Notas de transcri" },
  },
  {
    slug: "dom-casmurro",
    title: "Dom Casmurro",
    author: "Machado de Assis",
    lang: "pt",
    level: "B2",
    form: "prose",
    // Rio de Janeiro / Paris, Garnier, 1899 (dated 1900). PG #55752: Machado de Assis 1839–1908.
    workCountry: "BR",
    firstPublicationYear: 1899,
    creators: [{ name: "Machado de Assis", role: "author", deathYear: 1908 }],
    source: pg(55752),
    licence: PG_LICENCE,
    attribution: pgCredit(55752),
  },

  // ── Russian ──────────────────────────────────────────────────────────────
  {
    slug: "сказка-о-рыбаке-и-рыбке",
    title: "Сказка о рыбаке и рыбке",
    author: "Александр Пушкин",
    lang: "ru",
    level: "A2–B1",
    form: "verse",
    // Библиотека для чтения, May 1835. ru.wikisource (its header: Пушкин
    // 1799–1837; text from the Academy ПСС 1977–1979, vol. 4, in modern spelling).
    workCountry: "RU",
    firstPublicationYear: 1835,
    creators: [{ name: "Александр Пушкин", role: "author", deathYear: 1837 }],
    source: wikisource("ru.wikisource.org", "Сказка о рыбаке и рыбке (Пушкин)", 5019506),
    licence: WIKISOURCE_LICENCE,
    attribution: wsCredit("ru.wikisource.org", "Сказка о рыбаке и рыбке (Пушкин)", 5019506),
    // Not the 1977 edition's commentary after the tale (its editors' own text).
    range: { toMarkup: ">Примечания<" },
  },
  {
    slug: "каштанка",
    title: "Каштанка",
    author: "Антон Чехов",
    lang: "ru",
    level: "B1",
    form: "prose",
    // Новое время, 25 December 1887. ru.wikisource (its header: Чехов
    // 1860–1904; text from the Academy ПСС, vol. 6; the page's own footnotes are not imported).
    workCountry: "RU",
    firstPublicationYear: 1887,
    creators: [{ name: "Антон Чехов", role: "author", deathYear: 1904 }],
    source: wikisource("ru.wikisource.org", "Каштанка (Чехов)", 5628147),
    licence: WIKISOURCE_LICENCE,
    attribution: wsCredit("ru.wikisource.org", "Каштанка (Чехов)", 5628147),
  },

  // ── Japanese (Aozora Bunko: each card gives 初出, 没年, 底本 and its volunteers) ──
  // The 底本 are modern printings in 新字新仮名: modernised spelling is not a
  // new work, and Aozora keeps no editor's notes in the text. A character
  // outside JIS X 0208 is an image there (gaiji): imported as Aozora's own
  // placeholder ※, so a work with many is left out (蜘蛛の糸: 17, its hero's name).
  {
    slug: "注文の多い料理店",
    title: "注文の多い料理店",
    author: "宮沢賢治",
    lang: "ja",
    level: "A2–B1",
    form: "prose",
    // 「イーハトヴ童話 注文の多い料理店」杜陵出版部・東京光原社、1924年12月1日.
    // Card 43754: 宮沢 1896–1933.
    workCountry: "JP",
    firstPublicationYear: 1924,
    creators: [{ name: "宮沢賢治", role: "author", deathYear: 1933 }],
    source: aozora("000081", 43754, "43754_17659"),
    licence: AOZORA_LICENCE,
    attribution: aozoraCredit(
      "「注文の多い料理店」新潮文庫、新潮社",
      "入力：土屋隆、校正：noriko saito",
    ),
  },
  {
    slug: "どんぐりと山猫",
    title: "どんぐりと山猫",
    author: "宮沢賢治",
    lang: "ja",
    level: "A2–B1",
    form: "prose",
    // Same 1924 collection. Card 43752: 宮沢 1896–1933.
    workCountry: "JP",
    firstPublicationYear: 1924,
    creators: [{ name: "宮沢賢治", role: "author", deathYear: 1933 }],
    source: aozora("000081", 43752, "43752_17657"),
    licence: AOZORA_LICENCE,
    attribution: aozoraCredit(
      "「注文の多い料理店」新潮文庫、新潮社",
      "入力：土屋隆、校正：noriko saito",
    ),
  },
  {
    slug: "杜子春",
    title: "杜子春",
    author: "芥川竜之介",
    lang: "ja",
    level: "B1",
    form: "prose",
    // 「赤い鳥」1920年7月. Card 43015: 芥川 1892–1927.
    workCountry: "JP",
    firstPublicationYear: 1920,
    creators: [{ name: "芥川竜之介", role: "author", deathYear: 1927 }],
    source: aozora("000879", 43015, "43015_17432"),
    licence: AOZORA_LICENCE,
    attribution: aozoraCredit(
      "「蜘蛛の糸・杜子春」新潮文庫、新潮社",
      "入力：蒋龍、校正：noriko saito",
    ),
  },
  {
    slug: "鼻",
    title: "鼻",
    author: "芥川竜之介",
    lang: "ja",
    level: "B1",
    form: "prose",
    // 「新思潮」1916年2月. Card 42: 芥川 1892–1927.
    workCountry: "JP",
    firstPublicationYear: 1916,
    creators: [{ name: "芥川竜之介", role: "author", deathYear: 1927 }],
    source: aozora("000879", 42, "42_15228"),
    licence: AOZORA_LICENCE,
    attribution: aozoraCredit(
      "「芥川龍之介全集1」ちくま文庫、筑摩書房",
      "入力：平山誠、野口英司、校正：もりみつじゅんじ",
    ),
  },
  {
    slug: "夢十夜",
    title: "夢十夜",
    author: "夏目漱石",
    lang: "ja",
    level: "B1",
    form: "prose",
    // 東京・大阪朝日新聞, July–August 1908. Card 799: 夏目 1867–1916.
    workCountry: "JP",
    firstPublicationYear: 1908,
    creators: [{ name: "夏目漱石", role: "author", deathYear: 1916 }],
    source: aozora("000148", 799, "799_14972"),
    licence: AOZORA_LICENCE,
    attribution: aozoraCredit("「夏目漱石全集10巻」ちくま文庫、筑摩書房", "入力：野口英司"),
  },
  {
    slug: "坊っちゃん",
    title: "坊っちゃん",
    author: "夏目漱石",
    lang: "ja",
    level: "B2",
    form: "prose",
    // 「ホトトギス」1906年4月. Card 752: 夏目 1867–1916.
    workCountry: "JP",
    firstPublicationYear: 1906,
    creators: [{ name: "夏目漱石", role: "author", deathYear: 1916 }],
    source: aozora("000148", 752, "752_14964"),
    licence: AOZORA_LICENCE,
    attribution: aozoraCredit(
      "「ちくま日本文学全集 夏目漱石」筑摩書房",
      "入力：真先芳秋、校正：柳沢成雄",
    ),
  },

  // ── Chinese ──────────────────────────────────────────────────────────────
  {
    slug: "匆匆",
    title: "匆匆",
    author: "朱自清",
    lang: "zh",
    level: "A2–B1",
    form: "prose",
    // 《時事新報·文學旬刊》1922年4月11日. zh.wikisource (header and {{Pd/1923|1948}}):
    // 朱自清 1898–1948; text from 《踪跡》(1924).
    workCountry: "CN",
    firstPublicationYear: 1922,
    creators: [{ name: "朱自清", role: "author", deathYear: 1948 }],
    source: wikisource("zh.wikisource.org", "匆匆", 2570968),
    licence: WIKISOURCE_LICENCE,
    attribution: wsCredit("zh.wikisource.org", "匆匆", 2570968),
  },
  {
    slug: "背影",
    title: "背影",
    author: "朱自清",
    lang: "zh",
    level: "B1",
    form: "prose",
    // 《文学周报》第200期, 1925年11月22日. zh.wikisource (header and {{Pd/1923|1948}}):
    // 朱自清 1898–1948.
    workCountry: "CN",
    firstPublicationYear: 1925,
    creators: [{ name: "朱自清", role: "author", deathYear: 1948 }],
    source: wikisource("zh.wikisource.org", "背影", 2570094),
    licence: WIKISOURCE_LICENCE,
    attribution: wsCredit("zh.wikisource.org", "背影", 2570094),
  },
  {
    slug: "孔乙己",
    title: "孔乙己",
    author: "魯迅",
    lang: "zh",
    level: "B1–B2",
    form: "prose",
    // 《新青年》第6卷, 1919年4月 (written March 1919). zh.wikisource ({{Pd/1996|1936}}):
    // 魯迅 1881–1936; text from the 1938 《魯迅全集》, a work of the 魯迅先生紀念委員會
    // (an organisation; its own term, 50 years from 1938, has ended).
    workCountry: "CN",
    firstPublicationYear: 1919,
    creators: [{ name: "魯迅", role: "author", deathYear: 1936 }],
    source: wikisource("zh.wikisource.org", "孔乙己", 2605389),
    licence: WIKISOURCE_LICENCE,
    attribution: wsCredit("zh.wikisource.org", "孔乙己", 2605389),
  },
  {
    slug: "故鄉",
    title: "故鄉",
    author: "魯迅",
    lang: "zh",
    level: "B2",
    form: "prose",
    // 《新青年》第9卷第1號, 1921年5月1日. zh.wikisource ({{Pd/1996|1936}}): 魯迅
    // 1881–1936; text from the 1938 《魯迅全集》 (as for 孔乙己).
    workCountry: "CN",
    firstPublicationYear: 1921,
    creators: [{ name: "魯迅", role: "author", deathYear: 1936 }],
    source: wikisource("zh.wikisource.org", "故鄉", 2570945),
    licence: WIKISOURCE_LICENCE,
    attribution: wsCredit("zh.wikisource.org", "故鄉", 2570945),
  },

  // ── Latin ────────────────────────────────────────────────────────────────
  {
    slug: "fabulae",
    title: "Fabulae, virginibus puerisque aut narrandae aut recitandae",
    author: "R. B. Appleton",
    lang: "la",
    level: "A2–B1",
    form: "prose",
    // London, G. Bell and Sons, 1914 (its title page): stories written in
    // Latin for young readers. PG #57615: Appleton 1886–1938.
    workCountry: "GB",
    firstPublicationYear: 1914,
    creators: [{ name: "R. B. Appleton", role: "author", deathYear: 1938 }],
    source: pg(57615),
    licence: PG_LICENCE,
    attribution: pgCredit(57615),
    // From the first tale: not the transcriber's notes or the English preface.
    range: { from: "id00014" },
  },
  {
    slug: "de-bello-gallico-i-iv",
    title: "De Bello Gallico, I–IV",
    author: "C. Iulius Caesar",
    lang: "la",
    level: "B2–C1",
    form: "prose",
    // Written 58–49 BC; first printed at Rome (Sweynheym & Pannartz), 1469.
    // PG #218: Caesar 100–44 BC.
    workCountry: "IT",
    firstPublicationYear: 1469,
    creators: [{ name: "C. Iulius Caesar", role: "author", deathYear: -44 }],
    source: pg(218),
    licence: PG_LICENCE,
    attribution: pgCredit(218),
  },
];

/** "<lang>/<slug>": the entry's id in URLs, keys and the cache. */
export function bookKey(b: Pick<CatalogueBook, "lang" | "slug">): string {
  return `${b.lang}/${b.slug}`;
}

/** The import's source key (read_materials.source_key): one book per entry per user. */
export function presetSourceKey(b: Pick<CatalogueBook, "lang" | "slug">): string {
  return `preset:${bookKey(b)}`;
}

/** The entry for "<lang>/<slug>", or null. */
export function catalogueBook(
  key: unknown,
  list: CatalogueBook[] = CATALOGUE,
): CatalogueBook | null {
  if (typeof key !== "string") return null;
  return list.find((b) => bookKey(b) === key) ?? null;
}

/** A URL the server may fetch: https on a source host, default port, no credentials. */
export function allowedSourceUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.port || u.username || u.password) return null;
  return (SOURCE_HOSTS as readonly string[]).includes(u.hostname) ? u : null;
}

/** The latest first-publication year that is public domain in the US during `year`. */
export function usPdCutoff(year: number): number {
  return year - TERMS.US.publication!.years - 1;
}

const ROLES = new Set(["author", "translator", "editor", "illustrator"]);

/** Whether `b` may be shown to, and imported by, a viewer in `country` (null = unknown). */
export function bookVisibleIn(b: CatalogueBook, country: string | null, year: number): boolean {
  return pdForViewer(b, country, year);
}

/** The catalogue a viewer in `country` sees during `year`. */
export function catalogueFor(
  country: string | null,
  year: number,
  list: CatalogueBook[] = CATALOGUE,
): CatalogueBook[] {
  return list.filter((b) => bookVisibleIn(b, country, year));
}

/** Problems with the catalogue as of `year`; empty when every entry passes. */
export function checkCatalogue(list: CatalogueBook[], year: number): string[] {
  const out: string[] = [];
  const keys = new Set<string>();
  for (const b of list) {
    const at = `${bookKey(b)}:`;
    if (!SLUG_RE.test(b.slug) || b.slug !== slugOf(b.slug)) out.push(`${at} bad slug`);
    if (keys.has(bookKey(b))) out.push(`${at} duplicate slug`);
    keys.add(bookKey(b));
    if (!b.title.trim() || !b.author.trim()) out.push(`${at} title and author required`);
    if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(b.lang)) out.push(`${at} bad lang`);
    if (!/^[ABC][12](–[ABC][12])?\+?$/.test(b.level)) out.push(`${at} bad CEFR level`);
    if (!Number.isInteger(b.firstPublicationYear) || b.firstPublicationYear > year)
      out.push(`${at} first publication year missing`);
    if (normaliseCountry(b.workCountry) !== b.workCountry)
      out.push(`${at} workCountry must be an ISO 3166 code`);
    if (!b.creators.length) out.push(`${at} no creators`);
    for (const c of b.creators) {
      if (!c.name.trim() || !ROLES.has(c.role)) out.push(`${at} creator needs a name and a role`);
      if (!Number.isInteger(c.deathYear) || c.deathYear > year)
        out.push(`${at} ${c.name}: death year missing`);
    }
    if (!pdIn(b, "US", year)) out.push(`${at} not public domain in the US`);
    if (!pdIn(b, b.workCountry, year))
      out.push(`${at} not public domain in its country of first publication`);
    if (!allowedSourceUrl(b.source.file)) out.push(`${at} source file not on an allowed host`);
    if (!allowedSourceUrl(b.source.page)) out.push(`${at} source page not on an allowed host`);
    if (b.licence.trim().length < 10) out.push(`${at} licence line missing`);
    if (b.attribution.trim().length < 10) out.push(`${at} attribution missing`);
  }
  return out;
}

const LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"];
const levelRank = (l: string) => {
  const i = LEVELS.indexOf(l.slice(0, 2));
  return i < 0 ? LEVELS.length : i;
};

/** The catalogue grouped by language (first appearance), each group easiest level first. */
export function catalogueByLang(list: CatalogueBook[] = CATALOGUE): [string, CatalogueBook[]][] {
  const groups = new Map<string, CatalogueBook[]>();
  for (const b of list) groups.set(b.lang, [...(groups.get(b.lang) ?? []), b]);
  return [...groups].map(([lang, books]) => [
    lang,
    books
      .map((b, i) => [b, i] as const)
      .sort((x, y) => levelRank(x[0].level) - levelRank(y[0].level) || x[1] - y[1])
      .map(([b]) => b),
  ]);
}
