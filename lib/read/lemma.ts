// A language's dictionary for /read, beyond our word decks: which words are
// headwords (have a meaning of their own) and which inflected forms belong
// to which headword. Built by scripts/words/build-lemmas.ts from the
// kaikki.org English-Wiktionary extract (CC BY-SA 4.0; public/words/SOURCES.md,
// "Lemma files") and served as a static plain-text file per language (compressed by the CDN), loaded only
// when a book in that language is matched.
//
// Owner, 2026-11-03 18:53 JST, a French book: "这里未识别的词有点多" — forms
// such as "était", "regarda", "yeux" were unrecognised because our decks list
// lemmas (être, regarder, œil), and words outside the decks' 3,000 lemmas
// were unrecognised even when any dictionary has them.
//
// Plugging in another language: build `public/words/lemma/<lang>.txt` with
// the same script (or any tool writing the format below) and set "lemmas":
// true in lib/read/lang/<lang>.json. Nothing else changes: lib/read/words.ts foldsOf asks a
// Lemmas for a word's headwords, and the scan summary asks it whether a word
// is in the dictionary.
//
// File format v2 (UTF-8, NFC, lowercase); v1 is the same without the tags:
//   #lianki-lemmas v2 <lang>
//   #tags <tag> <tag> …        Wiktionary's grammatical tags; a tag's id is its place, from 0
//   #sets <set> <set> …        a form's readings: tag sets separated by ",", each
//                              tag ids joined by "."; a set's id is its place
//   <headword>[\t<form> <form> …]
// one headword per line; each form is written as <n><suffix>[:<set>]: drop n
// letters from the end of the headword and append the suffix (n ≥ 10 as ~n~),
// then the id of its readings (in the dictionary's order). With "#tags past
// historic third-person singular first-person present" and "#sets 0.1.2.3
// 5.4.3,5.2.3", "regarder\t2a:0 1:1" lists "regarda" (past historic,
// third-person singular) and "regarde" (present first-person singular;
// present third-person singular); a form without ":" has no tags. The
// most-used tags and sets come first, so their ids are short. Forms are spelled as a
// book's word is counted (elided clitics stripped, no hyphenated forms).

import { langRules } from "./lang";

/** The language has a lemma file ("lemmas": true in its lib/read/lang data). */
export const hasLemmas = (lang: string) => langRules(lang).data.lemmas === true;

/** Bump when a lemma file is rebuilt, so books store their entries again. */
export const LEMMA_V = 2;

/**
 * The dictionary entries one book's words need, stored with its word count
 * (WordStats.lex), so the server parses the lemma file once per book, not per
 * request: forms → headwords, and the headwords among the book's words.
 * `of` entries carry, per headword, the form's tag sets as tag ids into
 * `tags` ("3.7,3.9": two readings), "" for none.
 */
export interface BookLex {
  v: number;
  of: [string, string[], string[]?][];
  heads: string[];
  tags?: string[];
}

export const lemmaPath = (lang: string) => `/words/lemma/${lang}.txt`;

/** A form of a headword, with its grammatical tags (lib/read/form-tags.ts). */
export interface FormOf {
  lemma: string;
  /** The first reading's Wiktionary tags (["past", "historic", "third-person", "singular"]). */
  tags: readonly string[];
  /** Every reading's tags, the first one first; empty when the file has none. */
  sets: readonly (readonly string[])[];
}

/** What a language's dictionary says about words. */
export interface Lemmas {
  /** The headwords this form is an inflection of (empty when none). */
  of(form: string): readonly string[];
  /** The headwords this form is an inflection of, each with the form's tags. */
  forms(form: string): readonly FormOf[];
  /** The word is a headword: it has a meaning of its own. */
  has(word: string): boolean;
  /** These entries, to store with a book's words. */
  toLex(): BookLex;
}

/** Tag sets as tag ids: per form, per headword (aligned with `forms`), its readings. */
type FormSets = Map<string, (readonly (readonly number[])[])[]>;

function makeLemmas(
  heads: Set<string>,
  forms: Map<string, string[]>,
  tags: readonly string[] = NONE,
  sets: FormSets = new Map(),
): Lemmas {
  return {
    of: (f) => forms.get(f) ?? NONE,
    forms: (f) => {
      const hs = forms.get(f);
      if (!hs) return NO_FORMS;
      const ss = sets.get(f);
      return hs.map((lemma, i) => {
        const named = (ss?.[i] ?? []).map((s) => s.map((t) => tags[t]).filter(Boolean));
        return { lemma, tags: named[0] ?? NONE, sets: named };
      });
    },
    has: (w) => heads.has(w),
    toLex: () => ({
      v: LEMMA_V,
      of: [...forms].map(([f, hs]): BookLex["of"][number] => {
        const ss = sets.get(f);
        return ss?.some((s) => s.length)
          ? [f, hs, hs.map((_, i) => (ss[i] ?? []).map((s) => s.join(".")).join(","))]
          : [f, hs];
      }),
      heads: [...heads],
      ...(tags.length ? { tags: [...tags] } : {}),
    }),
  };
}

/** "3.7,3.9" → [[3, 7], [3, 9]]; ids past `n` tags are dropped. */
function idSets(code: string, n: number): number[][] {
  if (!code) return [];
  return code.split(",").map((s) =>
    s
      .split(".")
      .map(Number)
      .filter((t) => Number.isInteger(t) && t >= 0 && t < n),
  );
}

/** A book's stored entries as Lemmas; null when missing or from an older file. */
export function lemmasFromLex(raw: unknown): Lemmas | null {
  const lex = raw as Partial<BookLex> | null | undefined;
  if (!lex || lex.v !== LEMMA_V || !Array.isArray(lex.of) || !Array.isArray(lex.heads)) return null;
  const tags = Array.isArray(lex.tags) ? lex.tags.map((t) => (typeof t === "string" ? t : "")) : [];
  const forms = new Map<string, string[]>();
  const sets: FormSets = new Map();
  for (const e of lex.of)
    if (Array.isArray(e) && typeof e[0] === "string" && Array.isArray(e[1])) {
      const hs = e[1].filter((h): h is string => typeof h === "string");
      forms.set(e[0], hs);
      if (Array.isArray(e[2]))
        sets.set(
          e[0],
          hs.map((_, i) => idSets(typeof e[2]![i] === "string" ? e[2]![i] : "", tags.length)),
        );
    }
  return makeLemmas(
    new Set(lex.heads.filter((h): h is string => typeof h === "string")),
    forms,
    tags,
    sets,
  );
}

const NONE: readonly string[] = [];
const NO_FORMS: readonly FormOf[] = [];

/**
 * Parse a lemma file, v1 or v2. With `only` (a book's words and their folds),
 * keep just the forms and headwords it holds, plus the headwords those forms
 * point to: a few thousand entries instead of the whole dictionary.
 */
export function parseLemmas(text: string, only?: ReadonlySet<string>): Lemmas {
  const heads = new Set<string>();
  const forms = new Map<string, string[]>();
  const formSets: FormSets = new Map();
  let tags: string[] = [];
  let setTable: number[][][] = [];
  // A form keeps the first (length − n) letters of its headword, so when it
  // keeps three or more, it starts as the headword does: a line whose headword
  // starts as none of the wanted words do needs only its rare short-kept
  // forms ("œil" → "yeux") decoded. This keeps a parse to a few milliseconds.
  let starts: Set<string> | null = null;
  if (only) {
    starts = new Set();
    for (const w of only) starts.add(w.slice(0, 3));
  }
  const keep = (head: string, f: string, setId: string) => {
    if (only && !only.has(f)) return;
    let hs = forms.get(f);
    if (!hs) forms.set(f, (hs = []));
    let i = hs.indexOf(head);
    if (i < 0) i = hs.push(head) - 1;
    heads.add(head);
    const readings = setId ? setTable[Number(setId)] : undefined;
    if (!readings?.length) return;
    let ss = formSets.get(f);
    if (!ss) formSets.set(f, (ss = []));
    const mine = [...(ss[i] ?? [])];
    for (const r of readings) if (!mine.includes(r)) mine.push(r);
    ss[i] = mine;
  };
  // The header: the version line, then (v2) the tag and set tables.
  let start = 0;
  while (text.charCodeAt(start) === 35 /* # */) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end);
    if (line.startsWith("#tags ")) tags = line.slice(6).split(" ");
    else if (line.startsWith("#sets "))
      setTable = line
        .slice(6)
        .split(" ")
        .map((c) => idSets(c, tags.length));
    start = end + 1;
  }
  let tab = -1;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    if (tab < start) {
      tab = text.indexOf("\t", start);
      if (tab < 0) tab = text.length;
    }
    const hasForms = tab < end;
    const head = text.slice(start, hasForms ? tab : end);
    if (head && (!only || only.has(head))) heads.add(head);
    if (hasForms && head) {
      const all = !starts || starts.has(head.slice(0, 3));
      let p = tab + 1;
      while (p < end) {
        let q = text.indexOf(" ", p);
        if (q < 0 || q > end) q = end;
        const c = text.charCodeAt(p);
        // "~" codes drop ten letters or more; a digit d keeps length − d.
        if (all || c === 126 || head.length - (c - 48) < 3) {
          const code = text.slice(p, q);
          const colon = code.indexOf(":");
          const f = decodeForm(head, colon < 0 ? code : code.slice(0, colon));
          if (f) keep(head, f, colon < 0 ? "" : code.slice(colon + 1));
        }
        p = q + 1;
      }
    }
    start = end + 1;
  }
  return makeLemmas(heads, forms, tags, formSets);
}

/**
 * Write a form's code: "regarder" + "regarda" → "2a"; with its readings' set
 * id, "2a:0" (scripts/words/build-lemmas.ts; the inverse of the parse above).
 */
export function encodeForm(head: string, form: string, setId?: number): string {
  let i = 0;
  while (i < head.length && i < form.length && head[i] === form[i]) i++;
  const d = head.length - i;
  const code = (d < 10 ? String(d) : `~${d}~`) + form.slice(i);
  return setId === undefined ? code : `${code}:${setId}`;
}

function decodeForm(head: string, code: string): string | null {
  let n: number;
  let rest: string;
  if (code[0] === "~") {
    const j = code.indexOf("~", 1);
    if (j < 0) return null;
    n = Number(code.slice(1, j));
    rest = code.slice(j + 1);
  } else {
    n = code.charCodeAt(0) - 48;
    rest = code.slice(1);
  }
  if (!(n >= 0 && n <= head.length)) return null;
  return head.slice(0, head.length - n) + rest;
}

/** A fetched lemma file's bytes as text: gunzipped, unless the server already did. */
export async function lemmaText(buf: ArrayBuffer): Promise<string> {
  const b = new Uint8Array(buf);
  if (b[0] === 0x1f && b[1] === 0x8b) {
    const stream = new Blob([b]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  }
  return new TextDecoder().decode(b);
}
