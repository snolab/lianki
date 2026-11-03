#!/usr/bin/env bun
/**
 * Build a language's lemma file for /read (lib/read/lemma.ts): which words
 * the dictionary has (a headword with a meaning of its own), and which
 * inflected forms belong to which headword, so a book's "regarda", "yeux" or
 * "voyageuses" is matched to a card or list entry for "regarder", "œil" or
 * "voyageur", and a word outside our decks but in the dictionary counts as
 * "new" rather than "unrecognised".
 *
 * Source: the kaikki.org English-Wiktionary extract for the language
 * (wiktextract, Tatu Ylonen; CC BY-SA 4.0 and GFDL). Attribution is in
 * public/words/SOURCES.md, "Lemma files". Reproduce (RAW outside the repo;
 * downloads are untrusted data and are only JSON.parse'd):
 *
 *   RAW=/tmp/words-raw; mkdir -p $RAW/kaikki
 *   curl -sfL -o $RAW/kaikki/French.jsonl.gz \
 *     https://kaikki.org/dictionary/French/kaikki.org-dictionary-French.jsonl.gz
 *   gunzip -c $RAW/kaikki/French.jsonl.gz \
 *     | bun scripts/words/build-lemmas.ts fr public/words/lemma/fr.txt
 *
 * Size: every headword with all its forms (French 2026-10-30: 87,560
 * headwords, 329,104 forms, 2.5 MB, 389 KB gzip; the suffix coding lets gzip
 * fold regular conjugations). The file is read only by the server, once per
 * isolate, and a book stores the entries it needs (lib/read/lemma.ts), so the
 * device downloads none of it. A smaller file: pass a FrequencyWords list as
 * a third argument (`… fr <out> $RAW/freq/fr_50k.txt`) and only headwords
 * that occur in it, themselves or through a form, keep their forms
 * (French: 344 KB, and 0.3% more of a novel's running words unrecognised).
 *
 * Heavily inflected languages (Finnish: about 150 table forms per headword,
 * cases × numbers × possessive suffixes × clitics; 186 MB unfiltered) also
 * set FORMS_IN_FREQ=1: a headword keeps only the forms that occur in the
 * frequency list, so the file holds the forms people actually write. Finnish
 * with the list's top 200,000 words (the word lists' WORDS_SCAN floor), 2026-11-04:
 * 164,017 headwords, 129,981 forms, 2.7 MB (864 KB gzip), French's size;
 * the whole 2.5M-word list would give 779,195 forms and 6.6 MB, too much to
 * parse once per Worker isolate:
 *
 *   head -n 200000 $RAW/freq/fi_full.txt > $RAW/freq/fi_200k.txt
 *   curl -sfL -o $RAW/kaikki/Finnish.jsonl.gz \
 *     https://kaikki.org/dictionary/Finnish/kaikki.org-dictionary-Finnish.jsonl.gz
 *   gunzip -c $RAW/kaikki/Finnish.jsonl.gz | FORMS_IN_FREQ=1 \
 *     bun scripts/words/build-lemmas.ts fi public/words/lemma/fi.txt $RAW/freq/fi_200k.txt
 *
 * Format (UTF-8, NFC, lowercase), documented in lib/read/lemma.ts:
 *   line 1:  #lianki-lemmas v1 <lang>
 *   then one headword per line, optionally followed by a tab and its forms,
 *   space-separated, each written as <n><suffix>: drop n letters from the end
 *   of the headword and append the suffix (n ≥ 10 is written ~n~).
 *   "regarder\t2a 2ai 1" = regarder: regarda, regardai, regarde.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { gzipSync } from "node:zlib";
import { stripElision, unligate } from "@/lib/read/words";

const [lang, outPath, freqPath] = process.argv.slice(2);
if (!lang || !outPath) {
  console.error("usage: build-lemmas.ts <lang> <out.txt> [freq_50k.txt] < kaikki.jsonl");
  process.exit(1);
}

const freq = new Map<string, number>();
for (const line of freqPath ? readFileSync(freqPath, "utf8").split("\n") : []) {
  const [w, n] = line.trim().split(" ");
  if (w) freq.set(w.normalize("NFC").toLowerCase(), Number(n) || 0);
}

/** A single written word: letters, inner apostrophes and hyphens only. */
const WORD = /^\p{L}[\p{L}\p{M}'-]*$/u;
const norm = (s: string) =>
  s
    .normalize("NFC")
    .replace(/[’ʼ]/g, "'")
    .toLowerCase();
// Parts of speech that are not words a reader learns.
const SKIP_POS = new Set(["name", "character", "symbol", "punct", "prefix", "suffix", "infix"]);

/** Headword → its forms (table forms, and words that are a form of it). */
const forms = new Map<string, Set<string>>();
/** Words whose every sense is a form of something (candidate headwords if that fails). */
const formOnly = new Map<string, string[]>();
const own = new Set<string>();
const formOf: [string, string][] = [];

let seen = 0;
for await (const line of console) {
  if (!line) continue;
  seen++;
  let e: any;
  try {
    e = JSON.parse(line);
  } catch {
    continue;
  }
  if (typeof e.word !== "string" || SKIP_POS.has(String(e.pos))) continue;
  if (e.lang_code && e.lang_code !== lang) continue;
  const w = norm(e.word);
  if (!WORD.test(w)) continue;
  let hasOwn = false;
  const ofs: string[] = [];
  for (const s of Array.isArray(e.senses) ? e.senses : []) {
    const glosses = Array.isArray(s?.glosses) ? s.glosses : [];
    if (!glosses.length) continue;
    const of = [...(s.form_of ?? []), ...(s.alt_of ?? [])]
      .map((f: any) => (typeof f?.word === "string" ? norm(f.word) : ""))
      .filter(Boolean);
    // "au": contraction of à + le, a word in its own right.
    const tags: string[] = Array.isArray(s.tags) ? s.tags : [];
    if (of.length && !tags.includes("contraction")) ofs.push(...of);
    else hasOwn = true;
  }
  if (hasOwn) {
    own.add(w);
    const set = forms.get(w) ?? new Set<string>();
    for (const f of Array.isArray(e.forms) ? e.forms : []) {
      const tags: string[] = Array.isArray(f?.tags) ? f.tags : [];
      if (
        tags.some((t) =>
          /^(table-tags|inflection-template|romanization|class|multiword-construction)$/.test(t),
        )
      )
        continue;
      if (typeof f?.form !== "string") continue;
      // As a book's word is read (lib/read/words.ts normWord): "s'écria" is
      // met as "écria"; a hyphenated form is split by the segmenter, never met.
      const k = stripElision(norm(f.form), lang);
      if (k !== w && WORD.test(k) && !k.includes("-")) set.add(k);
    }
    forms.set(w, set);
  }
  for (const o of ofs) formOf.push([w, o]);
  if (!hasOwn && ofs.length) formOnly.set(w, [...(formOnly.get(w) ?? []), ...ofs]);
}

// "x is a form of y": x joins y's forms when y is a headword.
for (const [f, l] of formOf) if (forms.has(l) && f !== l) forms.get(l)!.add(f);
// A word that is only a form of something that is no headword ("au":
// contraction of "à le") is a headword itself, so it is not unrecognised.
for (const [w, ofs] of formOnly)
  if (!own.has(w) && !ofs.some((o) => own.has(o))) forms.set(w, forms.get(w) ?? new Set());

// "manœuvre" is often typed "manoeuvre": the written-out spelling is a form.
// (the language's ligatures, lib/read/lang)
for (const [h, set] of forms) {
  const plain = unligate(h, lang);
  if (plain !== h) set.add(plain);
}

const attested = (h: string) => {
  if (!freqPath || freq.has(h)) return true;
  for (const f of forms.get(h)!) if (freq.has(f)) return true;
  return false;
};
const enc = (h: string, f: string) => {
  let i = 0;
  while (i < h.length && i < f.length && h[i] === f[i]) i++;
  const d = h.length - i;
  return (d < 10 ? String(d) : `~${d}~`) + f.slice(i);
};

// FORMS_IN_FREQ=1: only forms the frequency list has (see the header).
const formsInFreq = process.env.FORMS_IN_FREQ === "1" && freq.size > 0;
const heads = [...forms.keys()].sort();
let withForms = 0;
let formCount = 0;
const lines = [`#lianki-lemmas v1 ${lang}`];
for (const h of heads) {
  const fs = attested(h)
    ? [...forms.get(h)!].filter((f) => !formsInFreq || freq.has(f)).sort()
    : [];
  if (fs.length) {
    withForms++;
    formCount += fs.length;
    lines.push(`${h}\t${fs.map((f) => enc(h, f)).join(" ")}`);
  } else lines.push(h);
}
const body = lines.join("\n") + "\n";
const gz = gzipSync(body, { level: 9 });
mkdirSync(dirname(outPath), { recursive: true });
// Plain text in public/ (archives are refused there, lib/security/public-dir.ts);
// the CDN compresses it in transit. A .gz path writes gzip.
writeFileSync(outPath, outPath.endsWith(".gz") ? gz : body);
console.error(
  `${lang}: ${seen} entries → ${heads.length} headwords, ${withForms} with ${formCount} forms; ${body.length} bytes, ${gz.length} gzip`,
);
