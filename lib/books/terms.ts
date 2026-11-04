// Copyright terms per country, as data, for the /books admission rule
// (docs/books-plan.md, "Admission rule: public domain per country").
//
// NOT LEGAL ADVICE. A conservative summary kept so the rule is visible and
// testable; re-verify with counsel before `books.catalogue` is on for users.
//
// One generic engine (`pdIn`), no per-country code: every difference is a
// field of a country's `Term`. All terms run to the end of the calendar year:
// life+N protects through 31 December of deathYear + N, so a work is public
// domain in `year` when deathYear + N < year. A work is checked against every
// creator of the edition (author, translator, editor, illustrator), so the
// last to die decides.
//
// Conservative choices (we never assume the rule of the shorter term):
// - a country not in the table gets DEFAULT_TERM: life+100 AND the US rule;
// - an unknown viewer country (no CF-IPCountry, "XX", Tor "T1") is that default;
// - Russia's +4 years for authors who worked or fought in the Second World War
//   is applied to everyone; Japan's wartime additions (戦時加算) are applied, at
//   the longest (~10.8 years, rounded up to 11), to every work first published
//   in an Allied country before 1952; Spain's life+80 applies to every creator
//   who died in or before 1987;
// - Mexico's life+100 is applied flat, without the older terms some works
//   may have expired under.
// Not modelled (no catalogue entry is affected; check by hand when adding one):
// France's +30 years for an author "mort pour la France"; the UK's perpetual
// right in Peter Pan; terms for anonymous, corporate or posthumous works; US
// works first published 1931–1977 whose copyright was not renewed (treated as
// protected); unpublished works in the UK (to 2039).
//
// Sources: national copyright acts as summarised by WIPO Lex
// (wipo.int/wipolex) and Wikipedia "List of countries' copyright lengths"
// (checked 2026-11-05); US: 17 U.S.C. §§ 302–304 and Cornell's "Copyright Term
// and the Public Domain in the United States" (Hirtle); Japan: 著作権法 51–58
// and 連合国及び連合国民の著作権の特例に関する法律 (1952); Canada: Budget
// Implementation Act 2022 (in force 2022-12-30); Japan's TPP11 amendment (in
// force 2018-12-30); Korea's 2011 amendment (in force 2013-07-01); Australia's
// US FTA Implementation Act 2004 (in force 2005-01-01); Russia: Civil Code
// art. 1281 and the 2004 law's transitional rule (terms not expired by
// 1993-01-01); Spain: Ley de Propiedad Intelectual, disp. trans. 4ª.

/** The roles a creator of an edition can have. */
export type CreatorRole = "author" | "translator" | "editor" | "illustrator";

export interface Creator {
  name: string;
  role: CreatorRole;
  deathYear: number;
}

/** What the rule needs to know about a work (a catalogue entry carries more). */
export interface Work {
  /** ISO 3166-1 alpha-2 of the country of first publication. */
  workCountry: string;
  firstPublicationYear: number;
  creators: Creator[];
}

export interface Term {
  /** Years of protection after the creator's death, to the end of that year. */
  life: number;
  /**
   * A non-retroactive extension: in force from `year`, it did not revive a
   * term that had already ended. A creator whose old term (deathYear +
   * `previousLife`, plus any wartime addition) ended before `year` stays
   * public domain; everyone else gets `life`.
   */
  extended?: { year: number; previousLife: number };
  /** A longer transitional term for creators who died in or before `diedBy`. */
  transitional?: { diedBy: number; life: number };
  /**
   * Wartime additions: `years` more for a work first published, before
   * `publishedBefore`, in one of `workCountries`.
   */
  wartime?: { years: number; workCountries: readonly string[]; publishedBefore: number };
  /**
   * The US publication rule instead of life+N for published works: public
   * domain once published more than `years` years ago (in or before
   * year − years − 1). Works first published from `lifeFrom` on (and
   * unpublished ones) follow life+`life`; those in between stay protected.
   */
  publication?: { years: number; lifeFrom: number };
  /** Also require the US rule (the conservative default). */
  andUs?: boolean;
  /** Why the entry is what it is: the act, an extension, what is not modelled. */
  note: string;
}

/** EU member states, all life+70 (Directive 2006/116/EC). Spain has its own row. */
const EU = [
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "SE",
] as const;

/** Countries whose works get Japan's wartime additions (the 1952 Allied-nations act). */
const JP_WARTIME_COUNTRIES = [
  "US",
  "GB",
  "FR",
  "CA",
  "AU",
  "NZ",
  "NL",
  "BE",
  "NO",
  "GR",
  "BR",
  "ZA",
  "LK",
  "PK",
  "LB",
] as const;

const LIFE_70_EU: Term = {
  life: 70,
  note: "EU/EEA term directive: life+70. France: +30 more for an author 'mort pour la France' (not modelled); the older wartime prorogations are absorbed into the 70 years (Cour de cassation, 2007).",
};

export const TERMS: Readonly<Record<string, Term>> = {
  US: {
    life: 70,
    publication: { years: 95, lifeFrom: 2003 },
    note: "Published works: 95 years from publication (published in or before year − 96 is public domain; 1930 in 2026). Works published 1931–2002 treated as protected (renewal not checked; pre-1978 works first published 1978–2002 are protected to at least 2047). Unpublished, or first published from 2003: life+70.",
  },
  ...Object.fromEntries(EU.map((c) => [c, LIFE_70_EU])),
  ES: {
    life: 70,
    transitional: { diedBy: 1987, life: 80 },
    note: "Life+70; creators who died before 7 December 1987 keep the old life+80 (rounded: died in or before 1987).",
  },
  // EEA and Switzerland: life+70 as in the EU.
  NO: LIFE_70_EU,
  IS: LIFE_70_EU,
  LI: LIFE_70_EU,
  CH: { life: 70, note: "Switzerland: life+70 (URG art. 29)." },
  GB: {
    life: 70,
    note: "CDPA 1988 s.12: life+70. Not modelled: Peter Pan's perpetual right; unpublished pre-1989 works to 2039.",
  },
  JP: {
    life: 70,
    extended: { year: 2018, previousLife: 50 },
    wartime: { years: 11, workCountries: JP_WARTIME_COUNTRIES, publishedBefore: 1952 },
    note: "Life+70 from 2018-12-30, not retroactive: a term (life+50, plus any wartime addition) ended by 2017 stays ended. Wartime additions for works of Allied nationals published before 1952: up to 3,929 days, taken as 11 years for every such work.",
  },
  CN: { life: 50, note: "Copyright Law art. 23 (2020 revision): life+50." },
  KR: {
    life: 70,
    extended: { year: 2013, previousLife: 50 },
    note: "Life+70 from 2013-07-01, not retroactive: a life+50 term ended by 2012 stays ended.",
  },
  BR: { life: 70, note: "Lei 9.610/98 art. 41: life+70 from 1 January after the death." },
  RU: {
    life: 74,
    extended: { year: 1993, previousLife: 50 },
    note: "Civil Code art. 1281: life+70, +4 for an author who worked or fought in the Second World War (applied to everyone). A term not running on 1993-01-01 (life+50 ended by 1992) stays ended.",
  },
  AU: {
    life: 70,
    extended: { year: 2005, previousLife: 50 },
    note: "Life+70 from 2005-01-01, not retroactive: a life+50 term ended by 2004 stays ended.",
  },
  CA: {
    life: 70,
    extended: { year: 2022, previousLife: 50 },
    note: "Life+70 from 2022-12-30, not retroactive: a life+50 term ended by 2021 stays ended.",
  },
  MX: {
    life: 100,
    note: "Ley Federal del Derecho de Autor art. 29 (2003): life+100, applied flat (older terms that already ended for some works are not credited).",
  },
  IN: { life: 60, note: "Copyright Act 1957 s.22: life+60." },
};

/** Any country not in TERMS, and a viewer whose country is unknown. */
export const DEFAULT_TERM: Term = {
  life: 100,
  andUs: true,
  note: "Conservative default for a country not in the table: life+100 and public domain in the US.",
};

/** ISO 3166-1 alpha-2 in upper case, or null for unknown ("XX", Tor's "T1", junk). */
export function normaliseCountry(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const c = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c) || c === "XX" || c === "T1") return null;
  return c;
}

/** The term for a country code; unknown or unlisted → DEFAULT_TERM. */
export function termFor(country: string | null | undefined): Term {
  const c = normaliseCountry(country);
  return (c && TERMS[c]) || DEFAULT_TERM;
}

/** The life term (with additions) that protects one creator of `work` under `t`. */
export function lifeYears(t: Term, work: Work, deathYear: number): number {
  const w = t.wartime;
  const extra =
    w &&
    w.workCountries.includes(work.workCountry.toUpperCase()) &&
    work.firstPublicationYear < w.publishedBefore
      ? w.years
      : 0;
  if (t.transitional && deathYear <= t.transitional.diedBy) return t.transitional.life + extra;
  if (t.extended && deathYear + t.extended.previousLife + extra < t.extended.year)
    return t.extended.previousLife + extra;
  return t.life + extra;
}

function lifePasses(t: Term, work: Work, year: number): boolean {
  return (
    work.creators.length > 0 &&
    work.creators.every(
      (c) => Number.isInteger(c.deathYear) && c.deathYear + lifeYears(t, work, c.deathYear) < year,
    )
  );
}

function termPasses(t: Term, work: Work, year: number): boolean {
  if (!Number.isInteger(work.firstPublicationYear)) return false;
  if (!t.publication) return lifePasses(t, work, year);
  const pub = work.firstPublicationYear;
  if (pub + t.publication.years < year) return true;
  return pub >= t.publication.lifeFrom && lifePasses(t, work, year);
}

/** Whether `work` is public domain in `country` during `year` (unknown country → the default). */
export function pdIn(work: Work, country: string | null | undefined, year: number): boolean {
  const t = termFor(country);
  if (!termPasses(t, work, year)) return false;
  return !t.andUs || termPasses(TERMS.US, work, year);
}

/**
 * The admission rule for one viewer: public domain in the work's country of
 * first publication, in the viewer's country, and in the US (our servers and
 * the sources are there). Never the rule of the shorter term.
 */
export function pdForViewer(work: Work, viewerCountry: string | null | undefined, year: number) {
  return (
    pdIn(work, "US", year) && pdIn(work, work.workCountry, year) && pdIn(work, viewerCountry, year)
  );
}

/** Every country code in the table, for listing where a work would be hidden. */
export function listedCountries(): string[] {
  return Object.keys(TERMS).sort();
}
