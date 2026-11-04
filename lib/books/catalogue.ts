// The shared public-domain catalogue shown at /books (docs/books-plan.md,
// "The catalogue: /books"). Data only: one entry per edition, in any
// language; one importer for all of them, no per-language code.
//
// Book texts are never in the repo. Each entry names the exact file the server
// fetches on demand (lib/books/source.ts), from one of SOURCE_HOSTS only; the
// fetched file is cached in R2 (`lianki-blobs`, `preset-cache/`) and shared by
// every user after the first import.
//
// The rule every entry must pass (checkCatalogue, unit/books-catalogue.test.ts):
// public domain in the US (first published 96+ years ago: in or before 1930 as
// of 2026) AND every creator of the edition (author, translator, editor,
// illustrator, author of an introduction) dead 80+ years. Original-language
// texts. Checked by hand on each source's catalogue page; the years are kept
// here so the check stays visible and testable.
//
// Client-safe (no server imports): /books renders from it.

import { SLUG_RE, slugOf } from "./slug";

/** Hosts the server may fetch a catalogue file from, and follow a redirect to. */
export const SOURCE_HOSTS = ["www.gutenberg.org"] as const;

/** The kinds of source file the importer reads (lib/books/source.ts). */
export type SourceFormat = "gutenberg-html";

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
  /** First publication year of the work (the US public-domain test). */
  published: number;
  /**
   * Every creator of this edition with the year they died (author,
   * translator, editor, illustrator, introduction): the 80-year test.
   */
  creators: { name: string; role: string; died: number }[];
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

export const CATALOGUE: CatalogueBook[] = [
  {
    slug: "histoires-ou-contes-du-temps-passé",
    title: "Histoires ou Contes du temps passé",
    author: "Charles Perrault",
    lang: "fr",
    level: "A1",
    form: "prose",
    published: 1697,
    // Andrew Lang's 1888 Oxford edition; only the 1697 prose tales are
    // imported (`range`), not his English introduction and notes.
    creators: [
      { name: "Charles Perrault", role: "author", died: 1703 },
      { name: "Andrew Lang", role: "editor", died: 1912 },
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
    published: 1668,
    creators: [{ name: "Jean de La Fontaine", role: "author", died: 1695 }],
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
    published: 1869,
    // Not #36780: its introduction is by Charles Sarolea (died 1953).
    creators: [{ name: "Alphonse Daudet", role: "author", died: 1897 }],
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
    published: 1885,
    // Includes "La Parure". Illustrations (not imported) by Paul Cousturier.
    creators: [
      { name: "Guy de Maupassant", role: "author", died: 1893 },
      { name: "Paul Cousturier", role: "illustrator", died: 1908 },
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
    published: 1759,
    // Beuchot's edition of the Œuvres (Lefèvre / Firmin Didot, 1829), with his preface and notes.
    creators: [
      { name: "Voltaire", role: "author", died: 1778 },
      { name: "Adrien Beuchot", role: "editor", died: 1851 },
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
    published: 1865,
    creators: [{ name: "Lewis Carroll", role: "author", died: 1898 }],
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
    published: 1915,
    creators: [{ name: "Franz Kafka", role: "author", died: 1924 }],
    source: pg(22367),
    licence: PG_LICENCE,
    attribution: pgCredit(22367),
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
  return year - 96;
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
    if (!Number.isInteger(b.published) || b.published > usPdCutoff(year))
      out.push(`${at} not public domain in the US`);
    if (!b.creators.length) out.push(`${at} no creators`);
    for (const c of b.creators)
      if (!Number.isInteger(c.died) || c.died + 80 >= year)
        out.push(`${at} ${c.name} died less than 80 years ago`);
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
