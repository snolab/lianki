// The /books 「找更多书」 guide: public-domain libraries, as data, grouped by
// language (docs/books-plan.md, "More libraries in the guide"). Client-safe.
//
// Each library says what it offers (tags the page translates), its licence or
// terms as the site states them (kept as written, like a catalogue entry's
// licence line), and how Lianki supports it:
//
// - "paste": a pasted link works. The host has a link parser and a metadata
//   reader in lib/books/resolve.ts and a cleaner in lib/books/source.ts; the
//   admission rule (lib/books/terms.ts) still decides each book.
// - "guide": the page links out only, with one reason why (no reader yet, the
//   site's terms, or records without the facts the rule needs).
//
// Every site here was checked on 2026-11-05: reachable, and its terms allow
// reading the texts there. Not listed, and why, in docs/books-plan.md.
// One generic list, no per-language code: a Wikisource site is one row of
// WIKISOURCE below, read by the same parser, cleaner and Wikidata reader.

/** What a library mostly holds; the page shows each tag in the viewer's language. */
export type LibraryOffer =
  | "literature" // novels, stories, poems, plays
  | "classics" // ancient and pre-modern texts
  | "documents" // historical documents, speeches, letters
  | "polished" // carefully proofread and typeset ebooks
  | "scans" // page images of printed books (often with OCR)
  | "scholarly"; // critical or annotated editions

/** Why a library is in the guide only. */
export type GuideReason =
  /** Its terms are fine, but Lianki has no reader for its links yet. */
  | "no-reader"
  /** Its terms allow non-commercial or private use only (or forbid automated access). */
  | "terms"
  /** Its records do not state the facts the admission rule needs. */
  | "no-facts";

export interface Library {
  /** Stable id (lower-case, hyphens). */
  id: string;
  /** As the site names itself (not translated). */
  name: string;
  /** The site's home or catalogue page, opened in a new tab. */
  url: string;
  /** The language group: a BCP 47 code, or "mul" for a library in many languages. */
  lang: string;
  offers: LibraryOffer[];
  /** The licence or terms, as the site states them. */
  licence: string;
  support: "paste" | "guide";
  /** For "guide": why links from it cannot be pasted. */
  why?: GuideReason;
  /** For "paste": one book link the parser accepts (checked by a test). */
  sample?: string;
}

/**
 * The Wikisource sites the paste box and the search read: host → the language
 * of its texts and the site's own name. Adding a row is all a new language
 * needs (the parser, cleaner and Wikidata reader are shared).
 */
export const WIKISOURCE: Readonly<Record<string, { lang: string; name: string }>> = {
  "en.wikisource.org": { lang: "en", name: "Wikisource" },
  "zh.wikisource.org": { lang: "zh", name: "维基文库" },
  "ru.wikisource.org": { lang: "ru", name: "Викитека" },
  "fr.wikisource.org": { lang: "fr", name: "Wikisource" },
  "de.wikisource.org": { lang: "de", name: "Wikisource" },
  "es.wikisource.org": { lang: "es", name: "Wikisource" },
  "it.wikisource.org": { lang: "it", name: "Wikisource" },
  "pt.wikisource.org": { lang: "pt", name: "Wikisource" },
  "la.wikisource.org": { lang: "la", name: "Vicifons" },
  "pl.wikisource.org": { lang: "pl", name: "Wikiźródła" },
  "uk.wikisource.org": { lang: "uk", name: "Вікіджерела" },
  "nl.wikisource.org": { lang: "nl", name: "Wikisource" },
  "sv.wikisource.org": { lang: "sv", name: "Wikisource" },
  "ja.wikisource.org": { lang: "ja", name: "ウィキソース" },
  "ko.wikisource.org": { lang: "ko", name: "위키문헌" },
  "ar.wikisource.org": { lang: "ar", name: "ويكي مصدر" },
  "he.wikisource.org": { lang: "he", name: "ויקיטקסט" },
  "bn.wikisource.org": { lang: "bn", name: "উইকিসংকলন" },
};

export const STANDARD_EBOOKS_HOST = "standardebooks.org";

const WIKISOURCE_TERMS =
  "Public-domain texts; the Wikisource transcription is CC BY-SA 4.0 (creativecommons.org/licenses/by-sa/4.0).";

/** A sample main-namespace page per site, for the parser test (any title parses). */
const wikisourceRows: Library[] = Object.entries(WIKISOURCE).map(([host, s]) => ({
  id: `wikisource-${s.lang}`,
  name: s.name,
  url: `https://${host}/`,
  lang: s.lang,
  offers: ["literature", "documents", "scans"],
  licence: WIKISOURCE_TERMS,
  support: "paste",
  sample: `https://${host}/wiki/Sample`,
}));

export const LIBRARIES: Library[] = [
  // ── Many languages ────────────────────────────────────────────────────────
  {
    id: "gutenberg",
    name: "Project Gutenberg",
    url: "https://www.gutenberg.org/",
    lang: "mul",
    offers: ["literature", "documents"],
    licence:
      "Public domain in the USA; distributed under the Project Gutenberg License (www.gutenberg.org/policy/license.html).",
    support: "paste",
    sample: "https://www.gutenberg.org/ebooks/33931",
  },
  {
    id: "internet-archive",
    name: "Internet Archive · Open Library",
    url: "https://archive.org/details/texts",
    lang: "mul",
    offers: ["scans"],
    licence:
      "Each item has its own rights statement; lending copies of in-copyright books sit beside public-domain scans (archive.org/about/terms).",
    support: "guide",
    why: "no-facts",
  },
  {
    id: "hathitrust",
    name: "HathiTrust",
    url: "https://www.hathitrust.org/",
    lang: "mul",
    offers: ["scans"],
    licence:
      "Full view only for works its review finds public domain (in the US, or worldwide); the rest is search-only.",
    support: "guide",
    why: "no-reader",
  },
  // ── English ───────────────────────────────────────────────────────────────
  {
    id: "standard-ebooks",
    name: "Standard Ebooks",
    url: "https://standardebooks.org/ebooks",
    lang: "en",
    offers: ["literature", "polished"],
    licence:
      "Public domain in the US; Standard Ebooks' own work is dedicated to the public domain (CC0 1.0).",
    support: "paste",
    sample: "https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice",
  },
  // ── Japanese ──────────────────────────────────────────────────────────────
  {
    id: "aozora",
    name: "青空文庫 Aozora Bunko",
    url: "https://www.aozora.gr.jp/",
    lang: "ja",
    offers: ["literature"],
    licence:
      "Public domain (著作権保護期間満了) works; Aozora Bunko asks that its input and proofreading volunteers be credited.",
    support: "paste",
    sample: "https://www.aozora.gr.jp/cards/000035/card1567.html",
  },
  // ── French ────────────────────────────────────────────────────────────────
  {
    id: "gallica",
    name: "Gallica (BnF)",
    url: "https://gallica.bnf.fr/",
    lang: "fr",
    offers: ["scans", "literature", "documents"],
    licence:
      "Non-commercial reuse is free with the credit “Source gallica.bnf.fr / BnF”; commercial reuse needs a paid licence.",
    support: "guide",
    why: "terms",
  },
  // ── German ────────────────────────────────────────────────────────────────
  {
    id: "dta",
    name: "Deutsches Textarchiv",
    url: "https://www.deutschestextarchiv.de/",
    lang: "de",
    offers: ["literature", "documents", "scholarly"],
    licence: "First editions transcribed under CC BY-SA (deutschestextarchiv.de).",
    support: "guide",
    why: "no-reader",
  },
  {
    id: "projekt-gutenberg-de",
    name: "Projekt Gutenberg-DE",
    url: "https://www.projekt-gutenberg.org/",
    lang: "de",
    offers: ["literature"],
    licence:
      "Its terms allow the texts for private use only (projekt-gutenberg.org/nutzungsbedingungen).",
    support: "guide",
    why: "terms",
  },
  // ── Spanish ───────────────────────────────────────────────────────────────
  {
    id: "cervantes-virtual",
    name: "Biblioteca Virtual Miguel de Cervantes",
    url: "https://www.cervantesvirtual.com/",
    lang: "es",
    offers: ["literature", "scholarly", "scans"],
    licence:
      "Free to read; reproduction is governed by its legal notice (cervantesvirtual.com/marco-legal), not an open licence.",
    support: "guide",
    why: "terms",
  },
  // ── Italian ───────────────────────────────────────────────────────────────
  {
    id: "liberliber",
    name: "Liber Liber",
    url: "https://liberliber.it/",
    lang: "it",
    offers: ["literature"],
    licence:
      "Free downloads for personal use; many editions carry a non-commercial Creative Commons licence.",
    support: "guide",
    why: "terms",
  },
  // ── Polish ────────────────────────────────────────────────────────────────
  {
    id: "wolne-lektury",
    name: "Wolne Lektury",
    url: "https://wolnelektury.pl/",
    lang: "pl",
    offers: ["literature", "polished"],
    licence: "Public-domain works; the library's editions are shared under CC BY-SA 3.0.",
    support: "guide",
    why: "no-reader",
  },
  // ── Swedish and Nordic ────────────────────────────────────────────────────
  {
    id: "runeberg",
    name: "Projekt Runeberg",
    url: "https://runeberg.org/",
    lang: "sv",
    offers: ["literature", "scans"],
    licence: "Nordic public-domain works, free to read and copy (runeberg.org).",
    support: "guide",
    why: "no-reader",
  },
  // ── Latin and Ancient Greek ───────────────────────────────────────────────
  {
    id: "perseus",
    name: "Perseus Digital Library · Scaife",
    url: "https://scaife.perseus.org/",
    lang: "la",
    offers: ["classics", "scholarly"],
    licence:
      "Greek and Latin texts under CC BY-SA; an edition's modern editor is a creator our rule must date.",
    support: "guide",
    why: "no-facts",
  },
  {
    id: "latin-library",
    name: "The Latin Library",
    url: "https://www.thelatinlibrary.com/",
    lang: "la",
    offers: ["classics"],
    licence: "Free to read; no licence or edition is stated for the texts.",
    support: "guide",
    why: "no-facts",
  },
  // ── Chinese ───────────────────────────────────────────────────────────────
  {
    id: "ctext",
    name: "中國哲學書電子化計劃 ctext.org",
    url: "https://ctext.org/",
    lang: "zh",
    offers: ["classics", "scans"],
    licence:
      "Free to read on the site; automated download is forbidden by its terms, and reuse is non-commercial only.",
    support: "guide",
    why: "terms",
  },
  // ── Hebrew ────────────────────────────────────────────────────────────────
  {
    id: "ben-yehuda",
    name: "פרויקט בן־יהודה Project Ben-Yehuda",
    url: "https://benyehuda.org/",
    lang: "he",
    offers: ["literature"],
    licence:
      "Public-domain works may be used for any purpose; works shown by permission of their rights holders may not be reused.",
    support: "guide",
    why: "no-reader",
  },
  // ── Every Wikisource we read ──────────────────────────────────────────────
  ...wikisourceRows,
];

/** The guide grouped by language, in first-appearance order ("mul" first). */
export function librariesByLang(list: Library[] = LIBRARIES): [string, Library[]][] {
  const groups = new Map<string, Library[]>();
  for (const l of list) groups.set(l.lang, [...(groups.get(l.lang) ?? []), l]);
  return [...groups];
}

/** Problems with the guide; empty when every entry is complete. */
export function checkLibraries(list: Library[]): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  for (const l of list) {
    const at = `${l.id}:`;
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(l.id)) out.push(`${at} bad id`);
    if (ids.has(l.id)) out.push(`${at} duplicate id`);
    ids.add(l.id);
    if (!l.name.trim()) out.push(`${at} name missing`);
    let url: URL | null = null;
    try {
      url = new URL(l.url);
    } catch {
      url = null;
    }
    if (!url || url.protocol !== "https:") out.push(`${at} url must be https`);
    if (l.lang !== "mul" && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(l.lang))
      out.push(`${at} bad lang`);
    if (!l.offers.length) out.push(`${at} offers missing`);
    if (l.licence.trim().length < 20) out.push(`${at} licence line missing`);
    if (l.support === "paste" && !l.sample) out.push(`${at} paste needs a sample link`);
    if (l.support === "guide" && !l.why) out.push(`${at} guide needs a reason`);
    if (l.support === "paste" && l.why) out.push(`${at} paste has no guide reason`);
  }
  return out;
}
