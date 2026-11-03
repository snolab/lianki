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
// File format v1 (UTF-8, NFC, lowercase):
//   #lianki-lemmas v1 <lang>
//   <headword>[\t<form> <form> …]
// one headword per line; each form is written as <n><suffix>: drop n letters
// from the end of the headword and append the suffix (n ≥ 10 as ~n~), so
// "regarder\t2a 1" lists "regarda" and "regarde". Forms are spelled as a
// book's word is counted (elided clitics stripped, no hyphenated forms).

import { langRules } from "./lang";

/** The language has a lemma file ("lemmas": true in its lib/read/lang data). */
export const hasLemmas = (lang: string) => langRules(lang).data.lemmas === true;

/** Bump when a lemma file is rebuilt, so books store their entries again. */
export const LEMMA_V = 1;

/**
 * The dictionary entries one book's words need, stored with its word count
 * (WordStats.lex), so the server parses the lemma file once per book, not per
 * request: forms → headwords, and the headwords among the book's words.
 */
export interface BookLex {
  v: number;
  of: [string, string[]][];
  heads: string[];
}

export const lemmaPath = (lang: string) => `/words/lemma/${lang}.txt`;

/** What a language's dictionary says about words. */
export interface Lemmas {
  /** The headwords this form is an inflection of (empty when none). */
  of(form: string): readonly string[];
  /** The word is a headword: it has a meaning of its own. */
  has(word: string): boolean;
  /** These entries, to store with a book's words. */
  toLex(): BookLex;
}

function makeLemmas(heads: Set<string>, forms: Map<string, string[]>): Lemmas {
  return {
    of: (f) => forms.get(f) ?? NONE,
    has: (w) => heads.has(w),
    toLex: () => ({ v: LEMMA_V, of: [...forms], heads: [...heads] }),
  };
}

/** A book's stored entries as Lemmas; null when missing or from an older file. */
export function lemmasFromLex(raw: unknown): Lemmas | null {
  const lex = raw as Partial<BookLex> | null | undefined;
  if (!lex || lex.v !== LEMMA_V || !Array.isArray(lex.of) || !Array.isArray(lex.heads)) return null;
  const forms = new Map<string, string[]>();
  for (const e of lex.of)
    if (Array.isArray(e) && typeof e[0] === "string" && Array.isArray(e[1]))
      forms.set(
        e[0],
        e[1].filter((h): h is string => typeof h === "string"),
      );
  return makeLemmas(new Set(lex.heads.filter((h): h is string => typeof h === "string")), forms);
}

const NONE: readonly string[] = [];

/**
 * Parse a lemma file. With `only` (a book's words and their folds), keep just
 * the forms and headwords it holds, plus the headwords those forms point to:
 * a few thousand entries instead of the whole dictionary.
 */
export function parseLemmas(text: string, only?: ReadonlySet<string>): Lemmas {
  const heads = new Set<string>();
  const forms = new Map<string, string[]>();
  // A form keeps the first (length − n) letters of its headword, so when it
  // keeps three or more, it starts as the headword does: a line whose headword
  // starts as none of the wanted words do needs only its rare short-kept
  // forms ("œil" → "yeux") decoded. This keeps a parse to a few milliseconds.
  let starts: Set<string> | null = null;
  if (only) {
    starts = new Set();
    for (const w of only) starts.add(w.slice(0, 3));
  }
  const keep = (head: string, f: string) => {
    if (only && !only.has(f)) return;
    const had = forms.get(f);
    if (had) {
      if (!had.includes(head)) had.push(head);
    } else forms.set(f, [head]);
    heads.add(head);
  };
  let start = text.startsWith("#") ? text.indexOf("\n") + 1 : 0;
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
          const f = decodeForm(head, text.slice(p, q));
          if (f) keep(head, f);
        }
        p = q + 1;
      }
    }
    start = end + 1;
  }
  return makeLemmas(heads, forms);
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
