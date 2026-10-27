#!/usr/bin/env bun
/**
 * Build the graded word lists served from public/words/ for the /words
 * fast vocabulary review feature. Every entry is just term + reading + back.
 *
 * Reproduce (RAW = any scratch dir OUTSIDE the repo; downloads are untrusted
 * data and are only parsed, never executed):
 *
 *   RAW=/tmp/words-raw; mkdir -p $RAW/{freq,kaikki,jlpt,hsk}
 *   # 1. Frequency ranks — hermitdave/FrequencyWords (OpenSubtitles 2018, CC BY-SA 4.0)
 *   for l in fr es de en ko it pt ru; do
 *     curl -sfL -o $RAW/freq/${l}_50k.txt \
 *       https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/$l/${l}_50k.txt
 *   done
 *   curl -sfL -o $RAW/freq/ja_full.txt \
 *     https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/ja/ja_full.txt
 *   # 2. Glosses — kaikki.org English-Wiktionary extracts (CC BY-SA 4.0 / GFDL),
 *   #    streamed through a filter so the multi-GB files never touch disk
 *   for p in fr:French es:Spanish de:German en:English ko:Korean it:Italian pt:Portuguese ru:Russian; do
 *     l=${p%%:*}; L=${p#*:}
 *     curl -sL https://kaikki.org/dictionary/$L/kaikki.org-dictionary-$L.jsonl \
 *       | bun scripts/words/filter-kaikki.ts $RAW/freq/${l}_50k.txt > $RAW/kaikki/$l.jsonl
 *   done
 *   # 3. JLPT — jamsinclair/open-anki-jlpt-decks (MIT; data from tanos.co.uk, CC BY)
 *   for n in 1 2 3 4 5; do
 *     curl -sfL -o $RAW/jlpt/n$n.csv \
 *       https://raw.githubusercontent.com/jamsinclair/open-anki-jlpt-decks/main/src/n$n.csv
 *   done
 *   # 4. HSK 3.0 — drkameleon/complete-hsk-vocabulary (MIT; glosses CC-CEDICT, CC BY-SA 4.0)
 *   for n in 1 2 3 4 5 6 7; do
 *     curl -sfL -o $RAW/hsk/new-$n.json \
 *       https://raw.githubusercontent.com/drkameleon/complete-hsk-vocabulary/main/wordlists/exclusive/new/$n.min.json
 *   done
 *   # 5. Build
 *   bun scripts/words/build-word-lists.ts $RAW public/words
 *
 * See public/words/SOURCES.md for licenses and attribution.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [RAW, OUT] = process.argv.slice(2);
if (!RAW || !OUT) {
  console.error("usage: build-word-lists.ts <raw-dir> <out-dir>");
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

type Entry = { term: string; reading?: string; back: string };
type ListMeta = {
  id: string;
  lang: string;
  name: string;
  level: string;
  count: number;
  file: string;
  source: string;
  license: string;
};
const index: ListMeta[] = [];

function writeList(meta: Omit<ListMeta, "count" | "file">, entries: Entry[]) {
  const file = `${meta.id}.json`;
  const clean = entries.map((e) =>
    e.reading ? { term: e.term, reading: e.reading, back: e.back } : { term: e.term, back: e.back },
  );
  writeFileSync(
    join(OUT, file),
    JSON.stringify({
      id: meta.id,
      lang: meta.lang,
      name: meta.name,
      level: meta.level,
      source: meta.source,
      license: meta.license,
      entries: clean,
    }),
  );
  index.push({ ...meta, count: clean.length, file });
  console.log(`${meta.id.padEnd(12)} ${clean.length}`);
}

/** Join senses with "; " keeping the result ≤ max chars (always ≥ 1 sense). */
function joinSenses(senses: string[], max = 80, maxSenses = 3): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let s of senses) {
    s = s
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[.;:,]+$/, "");
    if (!s || seen.has(s.toLowerCase())) continue;
    if (!out.length && s.length > max) s = truncate(s, max);
    const next = [...out, s].join("; ");
    if (next.length > max) {
      if (out.length) break;
    }
    seen.add(s.toLowerCase());
    out.push(s);
    if (out.length >= maxSenses) break;
  }
  return out.join("; ");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  // prefer cutting at a clause boundary, then a word boundary
  const cut = s.slice(0, max - 1);
  const clause = Math.max(cut.lastIndexOf(", "), cut.lastIndexOf("; "));
  if (clause > max * 0.5) return cut.slice(0, clause);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;(]+$/, "") + "…";
}

// ---------------------------------------------------------------- Japanese
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function buildJapanese() {
  const jaRank = new Map<string, number>();
  const freqPath = join(RAW, "freq/ja_full.txt");
  if (existsSync(freqPath)) {
    readFileSync(freqPath, "utf8")
      .split("\n")
      .forEach((l, i) => {
        const w = l.split(" ")[0];
        if (w && !jaRank.has(w)) jaRank.set(w, i);
      });
  }
  const hasKanji = (s: string) => /\p{Script=Han}/u.test(s);
  const rankOf = (expr: string, reading: string): number => {
    const tries = [expr, expr.replace(/\p{Script=Hiragana}+$/u, ""), reading];
    for (const t of tries) {
      if (!t) continue;
      if (t !== expr && t !== reading && !hasKanji(t)) continue;
      const r = jaRank.get(t);
      if (r !== undefined) return r;
    }
    return Infinity;
  };
  const seen = new Set<string>();
  for (const n of [5, 4, 3, 2, 1]) {
    const rows = parseCsv(readFileSync(join(RAW, `jlpt/n${n}.csv`), "utf8"));
    const header = rows.shift()!;
    const iE = header.indexOf("expression");
    const iR = header.indexOf("reading");
    const iM = header.indexOf("meaning");
    const items: (Entry & { rank: number; ord: number })[] = [];
    const byTerm = new Map<string, Entry & { rank: number; ord: number }>();
    rows.forEach((r, ord) => {
      const term = r[iE]?.trim();
      // drop grammar notes in readings: "(〜を) とお" → "とお"
      const reading = (r[iR] ?? "").replace(/\([^)]*\)/g, "").trim();
      const meaning = r[iM]?.trim();
      if (!term || !meaning) return;
      const key = `${term}|${reading}`;
      if (seen.has(key)) return;
      seen.add(key);
      // The source separates synonyms with ", " and senses with "; ".
      const senses = meaning.split(/;\s*/);
      let back = joinSenses(senses, 80);
      if (back.length > 80) back = truncate(back, 80);
      const item = {
        term,
        reading: reading && reading !== term ? reading : "",
        back,
        rank: rankOf(term, reading),
        ord,
      };
      // One card per written form: 外 そと "outside" + ほか "other" →
      // reading "そと・ほか", back "outside, exterior; other, the rest".
      const prev = byTerm.get(term);
      if (!prev) {
        byTerm.set(term, item);
        items.push(item);
        return;
      }
      if (item.reading && !prev.reading?.split("・").includes(item.reading))
        prev.reading = [prev.reading || term, item.reading].join("・");
      if (item.back !== prev.back) {
        const joined = `${prev.back}; ${item.back}`;
        prev.back = joined.length <= 80 ? joined : prev.back;
      }
      prev.rank = Math.min(prev.rank, item.rank);
    });
    items.sort((a, b) => a.rank - b.rank || a.ord - b.ord);
    writeList(
      {
        id: `ja-jlpt-n${n}`,
        lang: "ja",
        name: `Japanese · JLPT N${n}`,
        level: `N${n}`,
        source:
          "JLPT vocabulary: jamsinclair/open-anki-jlpt-decks (via chyyran/jlpt-anki-decks, from Jonathan Waller's tanos.co.uk lists); ordered by OpenSubtitles frequency (hermitdave/FrequencyWords)",
        license:
          "CC BY 4.0 (tanos.co.uk data); MIT (open-anki-jlpt-decks); CC BY-SA 4.0 (FrequencyWords ordering)",
      },
      items,
    );
  }
}

// ---------------------------------------------------------------- Chinese
function buildChinese() {
  const bands: [string, string][] = [
    ["1", "1"],
    ["2", "2"],
    ["3", "3"],
    ["4", "4"],
    ["5", "5"],
    ["6", "6"],
    ["7", "7–9"],
  ];
  const seen = new Set<string>();
  for (const [file, level] of bands) {
    const data = JSON.parse(readFileSync(join(RAW, `hsk/new-${file}.json`), "utf8")) as any[];
    const items: (Entry & { q: number; ord: number })[] = [];
    data.forEach((w, ord) => {
      const term = String(w.s ?? "");
      if (!term || seen.has(term)) return;
      const forms = Array.isArray(w.f) ? w.f : [];
      if (!forms.length) return;
      // Pick the form whose meanings are not just surname/variant notes.
      const isNoise = (m: string) =>
        /^(surname |abbr\. |variant of |old variant of |used in |see [^ ]|\(old\) variant|erhua variant|Japanese variant|\(Tw\))/i.test(
          m,
        );
      // Prefer common-noun readings (yǐ over Yǐ "Israel"), then the richest form.
      const score = (f: any) =>
        (/^\p{Lu}/u.test(String(f.i?.y ?? "")) ? 0 : 100) +
        (f.m ?? []).filter((m: string) => !isNoise(m)).length;
      const f = [...forms].sort((a: any, b: any) => score(b) - score(a))[0];
      const meanings: string[] = (f.m ?? []).filter((m: string) => !isNoise(m));
      const senses = (meanings.length ? meanings : (f.m ?? [])).flatMap((m: string) =>
        m.split(/;\s*/),
      );
      const back = joinSenses(senses, 80);
      if (!back) return;
      seen.add(term);
      items.push({
        term,
        reading: String(f.i?.y ?? ""),
        back,
        q: typeof w.q === "number" ? w.q : Infinity,
        ord,
      });
    });
    items.sort((a, b) => a.q - b.q || a.ord - b.ord);
    writeList(
      {
        id: `zh-hsk-${file === "7" ? "7-9" : file}`,
        lang: "zh",
        name: `Chinese · HSK 3.0 level ${level}`,
        level: `HSK ${level}`,
        source:
          "HSK 3.0 word lists: drkameleon/complete-hsk-vocabulary (lists from elkmovie/hsk30; definitions from CC-CEDICT via MDBG); ordered by its frequency rank",
        license: "MIT (complete-hsk-vocabulary); CC BY-SA 4.0 (CC-CEDICT definitions)",
      },
      items,
    );
  }
}

// ---------------------------------------------------------------- frequency + Wiktionary
type KSense = { g: string; tags: string[]; of: string[] };
type KEntry = { w: string; pos: string; senses: KSense[] };

const LANG_NAMES: Record<string, string> = {
  fr: "French",
  es: "Spanish",
  de: "German",
  en: "English",
  ko: "Korean",
  it: "Italian",
  pt: "Portuguese",
  ru: "Russian",
};
const SCRIPT: Record<string, RegExp> = {
  ru: /^[\p{Script=Cyrillic}][\p{Script=Cyrillic}'-]*$/u,
  ko: /^\p{Script=Hangul}+$/u,
};
const LATIN = /^[\p{Script=Latin}][\p{Script=Latin}'’-]*$/u;
const BAD_POS = new Set([
  "name",
  "character",
  "letter",
  "symbol",
  "prefix",
  "suffix",
  "infix",
  "interfix",
  "affix",
  "circumfix",
  "punct",
  "romanization",
  "abbrev",
  "proverb",
  "phrase",
  "syllable",
  "combining_form",
  "soft-redirect",
]);
const FUNCTION_POS = new Set([
  "pron",
  "prep",
  "conj",
  "det",
  "article",
  "adv",
  "particle",
  "num",
  "postp",
  "contraction",
  "prep_phrase",
]);
/** Never shown: slurs and the like, plus senses a learner should not meet first. */
/** Closed-class parts of speech whose sense goes first (adverbs excluded: schön is "beautiful" before "well"). */
const FIRST_POS = new Set([...FUNCTION_POS].filter((p) => p !== "adv"));
const BAD_TAGS = new Set([
  "offensive",
  "derogatory",
  "pejorative",
  "slur",
  "ethnic",
  "obsolete",
  "archaic",
  "rare",
  "dated",
  "historical",
  "dialectal",
  "nonstandard",
  "misspelling",
  "uncommon",
]);
/** Used only when the word has no neutral sense at all (e.g. a slang-only word). */
const SOFT_TAGS = new Set([
  "slang",
  "colloquial",
  "informal",
  "euphemistic",
  "vulgar",
  "humorous",
  "regional",
  "Internet",
  "childish",
  "Quebec",
  "Canada",
  "Belgium",
  "Switzerland",
  "Louisiana",
  "Acadia",
  "Cajun",
  "Africa",
  "Caribbean",
]);
const BAD_GLOSS = /\b(ethnic slur|derogatory|offensive|pejorative)\b/i;
const SOFT_GLOSS = /^(short for|clipping of)\b/i;
const FORM_TAGS = new Set([
  "form-of",
  "alt-of",
  "abbreviation",
  "initialism",
  "acronym",
  "misspelling",
]);
const FORMISH_GLOSS =
  /^(alternative|allomorph|prevocalic|elided|elision|apocopated|apocope|contracted|syncopated|clitic|enclitic|proclitic|obsolete|archaic|dated|nonstandard|informal|eye dialect|pronunciation|misspelling|abbreviation|initialism|contraction|clipping|apocopic|apheretic|plural|singular|feminine|masculine|inflection|diminutive|augmentative|superlative|comparative|gerund|past|present|imperative|first|second|third|simple|infinitive|form|elative|supine|nominative|genitive|dative|accusative|instrumental|prepositional|short|neuter|definite|indefinite|romanization|synonym)\b.*\bof\b/i;
const POS_LABEL: Record<string, string> = {
  noun: "noun",
  verb: "verb",
  adj: "adj",
  adv: "adv",
  pron: "pron",
  prep: "prep",
  conj: "conj",
  intj: "interj",
  det: "det",
  article: "article",
  num: "num",
  particle: "particle",
  postp: "postp",
};

/**
 * Hand-written backs for a few top-frequency function words whose Wiktionary
 * entry only has a descriptive definition ("The most common adverb of
 * negation…"). Keep this tiny; everything else comes from the data.
 */
const OVERRIDES: Record<string, Record<string, string>> = {
  fr: {
    pas: "not (with ne); (noun) step, pace",
    vous: "you (plural or formal)",
    nous: "we; us",
    du: "some (partitive); of the",
    se: "oneself, himself, herself, itself, themselves; each other",
  },
  es: { bien: "well; very; (noun) good, property" },
  it: { bene: "well; fine, OK; (noun) good, property" },
};

const stripStress = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀́]/g, "")
    .normalize("NFC");

async function loadKaikki(path: string): Promise<Map<string, KEntry[]>> {
  const byLower = new Map<string, KEntry[]>();
  const text = await Bun.file(path).text();
  for (const line of text.split("\n")) {
    if (!line) continue;
    const e = JSON.parse(line) as KEntry;
    const k = e.w.toLowerCase();
    let arr = byLower.get(k);
    if (!arr) byLower.set(k, (arr = []));
    arr.push(e);
  }
  return byLower;
}

function cleanGloss(g: string): string {
  let s = g
    .replace(/\s*\((?:see )?§[^)]*\)/g, "")
    // Korean hanja homonyms: "亂: revolt" → "revolt"
    .replace(/^[\p{Script=Han}]+:\s*/u, "");
  // long definitions: drop parenthetical usage notes to keep the back short
  if (s.length > 30) {
    const bare = s.replace(/\s*\([^()]*\)/g, "").trim();
    if (bare.length >= 2) s = bare;
  }
  return s
    .replace(/\s*\[[^\]]*\]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.:]+$/, "");
}

/** Lemma senses (non-form-of, non-obsolete) of an entry. */
/**
 * Pronoun/determiner forms are words a learner needs in their own right, and
 * Wiktionary spells out their meaning after the lemma: "accusative of yo: me",
 * "apocopic form of mío, my". Turn those into plain senses ("me", "my").
 */
function functionFormSense(e: KEntry, s: KSense): KSense | null {
  if (!s.of.length || !/^(pron|det|article)$/.test(e.pos)) return null;
  if (s.tags.some((t) => BAD_TAGS.has(t))) return null;
  const m = /\bof [^\s:,;.]+(?: [^\s:,;.]+)?\s*[:,;.]\s*(.+)$/.exec(s.g);
  if (!m || /\bof\b/.test(m[1]) || m[1].length > 40) return null;
  return { g: m[1], tags: s.tags.filter((t) => !FORM_TAGS.has(t)), of: [] };
}

function lemmaSenses(e: KEntry, soft = false): string[] {
  if (BAD_POS.has(e.pos)) return [];
  const ok = e.senses
    .map((s) => functionFormSense(e, s) ?? s)
    .filter(
      (s) =>
        !s.of.length &&
        !s.tags.some((t) => FORM_TAGS.has(t)) &&
        !FORMISH_GLOSS.test(s.g) &&
        !/\b(abbreviation|initialism|acronym|interrogative form) of\b/i.test(s.g) &&
        !/\b(?:form|forms|inflection) of (?!address)/i.test(s.g) &&
        !/^(?:a |the )?(?:name of |letter |surname)/i.test(s.g) &&
        !/^the (?:\w+ )?(?:script )?letter\b/i.test(s.g) &&
        !/\bspelling\b.*\bof\b|\bjamo\b|\bGreek letter\b|\bnumeral symbol\b|\bletter of the .*alphabet\b/i.test(
          s.g,
        ),
    );
  const good = ok.filter((s) => !s.tags.some((t) => BAD_TAGS.has(t)) && !BAD_GLOSS.test(s.g));
  const neutral = good.filter(
    (s) => !s.tags.some((t) => SOFT_TAGS.has(t)) && !SOFT_GLOSS.test(s.g),
  );
  return (soft ? good : neutral).map((s) => cleanGloss(s.g)).filter(Boolean);
}

function formTargets(e: KEntry, lang: string): string[] {
  if (BAD_POS.has(e.pos)) return [];
  return e.senses
    .filter((s) => s.of.length && s.tags.some((t) => t === "form-of" || t === "alt-of"))
    .flatMap((s) => s.of)
    .map((w) => (lang === "ru" ? stripStress(w) : w));
}

type Resolved = { term: string; back: string } | null;

/**
 * Which part of speech leads the back: closed-class words (pronouns,
 * articles…) first, then the entry with the most senses — a rough proxy for
 * the main use (bene adv "well" over adj "posh", schön adj over adv).
 */
const rankEntry = (e: { pos: string; senses: string[]; n: number }) =>
  (FIRST_POS.has(e.pos) ? 1000 : 0) + e.n + (e.pos === "noun" ? 0 : 1);

/** Descriptive definitions ("The most common adverb of …") read badly on a card. */
const descriptive = (g: string) =>
  /^(used|denotes|indicates|expresses)\b/i.test(g)
    ? 2
    : /^\p{Lu}/u.test(g) && g.split(" ").length >= 4
      ? 1
      : 0;

function makeBack(raw: { pos: string; senses: string[] }[], term = ""): string {
  const entries = raw.map((e) => {
    // A gloss equal to the term is a real cognate meaning (kilo → "kilo") when it
    // comes first; later it is usually a technical homonym (bague → … "bague").
    const parts = e.senses
      .flatMap((g) => g.split(/;\s+/))
      .filter((g, i) => g && (i === 0 || g.toLowerCase() !== term.toLowerCase()));
    // stable: concise glosses before descriptive ones; for pronouns and
    // determiners led by a definition, the shortest gloss is the translation (yo → "I").
    parts.sort((a, b) => descriptive(a) - descriptive(b));
    if (/^(pron|det|article)$/.test(e.pos) && (parts[0]?.split(" ").length ?? 0) >= 4)
      parts.sort((a, b) => a.length - b.length);
    return { pos: e.pos, senses: parts, n: e.senses.length };
  });
  // function words first: "pas" → adverb "not" before noun "step"
  const withSenses = entries
    .filter((e) => e.senses.length)
    .sort((a, b) => rankEntry(b) - rankEntry(a));
  if (!withSenses.length) return "";
  const first = withSenses[0];
  const parts: string[] = [first.senses[0]];
  const firstPos = first.pos;
  const seenPos = new Set([firstPos]);
  for (const e of withSenses.slice(1)) {
    if (seenPos.has(e.pos)) continue;
    if (parts.some((p) => p.replace(/^\([^)]*\) /, "").toLowerCase() === e.senses[0].toLowerCase()))
      continue;
    seenPos.add(e.pos);
    const label = POS_LABEL[e.pos] ?? e.pos;
    parts.push(`(${label}) ${e.senses[0]}`);
  }
  // fill with further senses of the first part of speech
  const extra = withSenses.filter((e) => e.pos === firstPos).flatMap((e) => e.senses);
  const head = parts.slice(0, 1);
  const tail = parts.slice(1);
  return joinSenses([...head, ...extra.slice(1, 3), ...tail].slice(0, 6), 80, 3);
}

/**
 * English backs are definitions, not translations. English Wiktionary lists
 * the main etymology and the main sense first, so keep that order and take
 * the first definition, plus a second part of speech when it fits.
 */
function makeBackEn(raw: { pos: string; senses: string[] }[]): string {
  const entries = raw.filter((e) => e.senses.length);
  if (!entries.length) return "";
  const lc = (g: string) => (/^(?:\p{Lu}\p{Ll}|A )/u.test(g) ? g[0].toLowerCase() + g.slice(1) : g);
  const first = truncate(lc(entries[0].senses[0]), 80);
  const parts = [first];
  const other = entries.find((e) => e.pos !== entries[0].pos);
  const candidates = [
    entries[0].senses[1] ? lc(entries[0].senses[1]) : "",
    other ? `(${POS_LABEL[other.pos] ?? other.pos}) ${lc(other.senses[0])}` : "",
  ];
  for (const c of candidates) {
    if (c && [...parts, c].join("; ").length <= 80 && !parts.includes(c)) parts.push(c);
  }
  return parts.join("; ");
}

const EN_JUNK = new Set(
  "don won didn doesn isn wasn aren couldn wouldn shouldn haven hasn hadn weren ain ll ve re em ya gonna wanna gotta".split(
    " ",
  ),
);

function buildFrequencyLang(lang: string, dict: Map<string, KEntry[]>) {
  const scriptOk = SCRIPT[lang] ?? LATIN;
  const pick = (word: string): KEntry[] => {
    const all = dict.get(word.toLowerCase()) ?? [];
    const exact = all.filter((e) => e.w === word);
    if (lang === "en" && word === "i") return all.filter((e) => e.w === "I");
    const usable = exact.some((e) => lemmaSenses(e, true).length || formTargets(e, lang).length);
    // German: lowercase subtitle tokens of nouns (zeit) should reach the noun
    // (Zeit) unless the lowercase word is itself a verb, adjective or pronoun.
    const deNoun =
      lang === "de" &&
      !exact.some(
        (e) => /^(verb|adj|pron|det|article|conj|num)$/.test(e.pos) && lemmaSenses(e, true).length,
      ) &&
      all.some(
        (e) =>
          e.w === word[0].toUpperCase() + word.slice(1) &&
          e.pos === "noun" &&
          lemmaSenses(e).length,
      );
    if (usable && !deNoun) return exact;
    // Case fallback: German nouns (zeit → Zeit), English "I", etc.
    // Only a capitalised first letter counts — not acronyms (big → BIG).
    // Only German (capitalised nouns) and English "I" need it; elsewhere a
    // capitalised-only match is usually a name (kevin → Kevin).
    if (lang !== "de" && !(lang === "en" && word === "i")) return [];
    const cap = word[0].toUpperCase() + word.slice(1);
    const other = all.filter((e) => e.w === cap && e.w !== word && !BAD_POS.has(e.pos));
    // Prefer the casing variant with the most lemma senses.
    const byCase = new Map<string, KEntry[]>();
    for (const e of other) byCase.set(e.w, [...(byCase.get(e.w) ?? []), e]);
    let best: KEntry[] = [];
    let bestScore = 0;
    for (const es of byCase.values()) {
      const score = es.reduce((n, e) => n + lemmaSenses(e, true).length, 0);
      if (score > bestScore) {
        best = es;
        bestScore = score;
      }
    }
    return best;
  };
  const glossOf = (word: string): Resolved => {
    const es = pick(word);
    if (!es.length) return null;
    const mb = lang === "en" ? (r: { pos: string; senses: string[] }[]) => makeBackEn(r) : makeBack;
    const back =
      OVERRIDES[lang]?.[es[0].w] ||
      mb(
        es.map((e) => ({ pos: e.pos, senses: lemmaSenses(e) })),
        es[0].w,
      ) ||
      mb(
        es.map((e) => ({ pos: e.pos, senses: lemmaSenses(e, true) })),
        es[0].w,
      );
    return back ? { term: es[0].w, back } : null;
  };
  const lines = readFileSync(join(RAW, `freq/${lang}_50k.txt`), "utf8").split("\n");
  const rank = new Map<string, number>();
  lines.forEach((l, i) => {
    const w = l.split(" ")[0]?.toLowerCase();
    if (w && !rank.has(w)) rank.set(w, i);
  });
  const resolve = (word: string): Resolved => {
    const es = pick(word);
    if (!es.length) return null;
    const lemmaEntries = es.filter((e) => lemmaSenses(e, true).length);
    const hasFunctionLemma = lemmaEntries.some((e) => FUNCTION_POS.has(e.pos));
    let targets = es
      .flatMap((e) => formTargets(e, lang))
      .filter((t) => t.toLowerCase() !== word.toLowerCase());
    // A word that is also a lemma in its own right (terre "earth", also a form
    // of the rare verb terrer) stays itself unless its lemma is common
    // (est → être). Pure inflections always fold into their lemma.
    if (lemmaEntries.length)
      targets = targets.filter((t) => (rank.get(t.toLowerCase()) ?? Infinity) < 10000);
    if (targets.length && !hasFunctionLemma) {
      // inflected form → its lemma (one more hop if the lemma is itself a form)
      for (const t of targets) {
        const r = glossOf(t);
        if (r) return r;
        const t2 = pick(t).flatMap((e) => formTargets(e, lang))[0];
        if (t2) {
          const r2 = glossOf(t2);
          if (r2) return r2;
        }
      }
      return null;
    }
    return glossOf(word);
  };

  const out: Entry[] = [];
  const seen = new Set<string>();
  const TARGET = 3000;
  for (const line of lines) {
    if (out.length >= TARGET) break;
    const word = line.split(" ")[0]?.trim();
    if (!word) continue;
    if (!scriptOk.test(word) || /['’-]$/.test(word)) continue;
    if (lang === "en" && EN_JUNK.has(word)) continue; // pieces of contractions
    if ([...word].length < 2 && lang !== "ko") {
      // single letters are mostly subtitle junk; keep real one-letter words
      // (à, y, и) or inflections of a lemma (pt é → ser)
      const r = resolve(word);
      const isFunction = pick(word).some((e) => FUNCTION_POS.has(e.pos) && lemmaSenses(e).length);
      if (!r || (!isFunction && r.term.toLowerCase() === word.toLowerCase())) continue;
    }
    const r = resolve(word);
    if (!r) continue;
    const key = r.term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ term: r.term, back: r.back });
  }
  const name = LANG_NAMES[lang];
  for (let b = 0; b * 500 < out.length; b++) {
    const lo = b * 500 + 1;
    const hi = Math.min(out.length, (b + 1) * 500);
    writeList(
      {
        id: `${lang}-freq-${b + 1}`,
        lang,
        name: `${name} · top ${lo}–${hi}`,
        level: `${lo}–${hi}`,
        source: `Ranks: hermitdave/FrequencyWords (OpenSubtitles 2018, ${lang}_50k); glosses: English Wiktionary via kaikki.org (${name} extract), inflected forms folded into lemmas`,
        license: "CC BY-SA 4.0 (FrequencyWords; Wiktionary content, also GFDL)",
      },
      out.slice(b * 500, (b + 1) * 500),
    );
  }
}

// ---------------------------------------------------------------- main
const only = process.env.WORDS_ONLY?.split(",");
const want = (l: string) => !only || only.includes(l);
if (want("ja")) buildJapanese();
if (want("zh")) buildChinese();
for (const lang of ["fr", "es", "de", "en", "ko", "it", "pt", "ru"]) {
  if (!want(lang)) continue;
  const p = join(RAW, `kaikki/${lang}.jsonl`);
  if (!existsSync(p)) {
    console.warn(`skip ${lang}: ${p} missing`);
    continue;
  }
  buildFrequencyLang(lang, await loadKaikki(p));
}

// merge with an existing index so partial (WORDS_ONLY) runs keep other lists
const indexPath = join(OUT, "index.json");
let lists: ListMeta[] = [];
if (only && existsSync(indexPath)) {
  lists = (JSON.parse(readFileSync(indexPath, "utf8")).lists as ListMeta[]).filter(
    (l) => !index.some((n) => n.id === l.id) && !only.includes(l.lang),
  );
}
const order = ["ja", "zh", "fr", "es", "de", "en", "ko", "it", "pt", "ru"];
// stable sort: language order, then build order (N5→N1, HSK 1→7–9, band 1→6)
lists = [...lists, ...index].sort((a, b) => order.indexOf(a.lang) - order.indexOf(b.lang));
writeFileSync(indexPath, JSON.stringify({ lists }));
console.log(`index.json: ${lists.length} lists`);
