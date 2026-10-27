#!/usr/bin/env bun
/**
 * Build the graded word lists served from public/words/ for the /words
 * fast vocabulary review feature. Every entry is term + reading + back, plus
 * an optional example sentence (ex) with its English translation (exTr).
 *
 * Reproduce (RAW = any scratch dir OUTSIDE the repo; downloads are untrusted
 * data and are only parsed, never executed):
 *
 *   RAW=/tmp/words-raw; mkdir -p $RAW/{freq,kaikki,jlpt,hsk,tatoeba}
 *   # 1. Frequency ranks — hermitdave/FrequencyWords (OpenSubtitles 2018, CC BY-SA 4.0)
 *   for l in fr es de en ko it pt ru; do
 *     curl -sfL -o $RAW/freq/${l}_50k.txt \
 *       https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/$l/${l}_50k.txt
 *   done
 *   curl -sfL -o $RAW/freq/ja_full.txt \
 *     https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/ja/ja_full.txt
 *   # 2. Glosses — kaikki.org English-Wiktionary extracts (CC BY-SA 4.0 / GFDL),
 *   #    streamed through a filter so the multi-GB files never touch disk
 *   for p in fr:French es:Spanish de:German en:English it:Italian pt:Portuguese ru:Russian; do
 *     l=${p%%:*}; L=${p#*:}
 *     curl -sL https://kaikki.org/dictionary/$L/kaikki.org-dictionary-$L.jsonl \
 *       | bun scripts/words/filter-kaikki.ts $RAW/freq/${l}_50k.txt > $RAW/kaikki/$l.jsonl
 *   done
 *   # (the same files exist as .jsonl.gz, 6× smaller: curl -sL ….jsonl.gz | gunzip | bun …)
 *   # Korean also keeps every verb/adjective with its conjugation table (팔고 → 팔다)
 *   curl -sL https://kaikki.org/dictionary/Korean/kaikki.org-dictionary-Korean.jsonl \
 *     | KAIKKI_FORMS=1 bun scripts/words/filter-kaikki.ts $RAW/freq/ko_50k.txt > $RAW/kaikki/ko.jsonl
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
 *   # 5. Example sentences — Tatoeba per-language exports (CC BY 2.0 FR), plus
 *   #    the English sentences their translations point to
 *   for t in fra spa deu kor ita por rus jpn cmn; do
 *     curl -sfL https://downloads.tatoeba.org/exports/per_language/$t/${t}_sentences.tsv.bz2 | bunzip2 > $RAW/tatoeba/${t}_sentences.tsv
 *     curl -sfL https://downloads.tatoeba.org/exports/per_language/$t/$t-eng_links.tsv.bz2 | bunzip2 > $RAW/tatoeba/$t-eng_links.tsv
 *   done
 *   curl -sfL https://downloads.tatoeba.org/exports/per_language/eng/eng_sentences.tsv.bz2 | bunzip2 > $RAW/tatoeba/eng_sentences.tsv
 *   # 6. Build
 *   bun scripts/words/build-word-lists.ts $RAW public/words
 *
 * See public/words/SOURCES.md for licenses and attribution.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ExamplePicker, loadTatoeba, wiktionaryExample, type Example } from "./examples";
import { NOUN_EVIDENCE, stripParticles, unfuse, verbForms } from "./korean";

const [RAW, OUT] = process.argv.slice(2);
if (!RAW || !OUT) {
  console.error("usage: build-word-lists.ts <raw-dir> <out-dir>");
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

type Entry = { term: string; reading?: string; back: string; ex?: string; exTr?: string };
const EX_SOURCE = "; example sentences: Tatoeba (tatoeba.org)";
const EX_SOURCE_WIKT = "; example sentences: Wiktionary usage examples, then Tatoeba (tatoeba.org)";
const EX_LICENSE = "; CC BY 2.0 FR (Tatoeba sentences)";
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
  const clean = entries.map((e) => ({
    term: e.term,
    ...(e.reading ? { reading: e.reading } : {}),
    back: e.back,
    ...(e.ex ? { ex: e.ex } : {}),
    ...(e.ex && e.exTr ? { exTr: e.exTr } : {}),
  }));
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

/**
 * Keep sentences whose Han characters all occur in the level lists: simple
 * sentences, and for Chinese no traditional characters (Tatoeba mixes both).
 */
function onlyKnownHan<T extends { s: string }>(sents: T[], vocab: string[]): T[] {
  const known = new Set(vocab.flatMap((v) => [...v]));
  return sents.filter((x) => [...x.s].every((c) => !/\p{Script=Han}/u.test(c) || known.has(c)));
}

/** Words of a list that contain `t` (面白い contains 白), for example matching. */
function longerIn(vocab: string[]) {
  return (t: string) => vocab.filter((v) => v.length > t.length && v.includes(t));
}

function buildJapanese() {
  const jaVocab = [5, 4, 3, 2, 1].flatMap((n) =>
    parseCsv(readFileSync(join(RAW, `jlpt/n${n}.csv`), "utf8"))
      .slice(1)
      .map((r) => r[0]?.trim())
      .filter(Boolean),
  );
  const jaPicker = new ExamplePicker("ja", onlyKnownHan(loadTatoeba(RAW, "ja"), jaVocab));
  const longerJa = longerIn(jaVocab);
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
    // examples: the exact written form first, then its kana reading
    for (const it of items) {
      // short kana readings (あう) match inside too many other words
      const kana = (it.reading || "").split("・").filter((k) => k.length >= 3);
      Object.assign(it, jaPicker.pick([it.term], kana, longerJa(it.term)) ?? {});
    }
    writeList(
      {
        id: `ja-jlpt-n${n}`,
        lang: "ja",
        name: `Japanese · JLPT N${n}`,
        level: `N${n}`,
        source:
          "JLPT vocabulary: jamsinclair/open-anki-jlpt-decks (via chyyran/jlpt-anki-decks, from Jonathan Waller's tanos.co.uk lists); ordered by OpenSubtitles frequency (hermitdave/FrequencyWords)" +
          EX_SOURCE,
        license:
          "CC BY 4.0 (tanos.co.uk data); MIT (open-anki-jlpt-decks); CC BY-SA 4.0 (FrequencyWords ordering)" +
          EX_LICENSE,
      },
      items,
    );
  }
}

// ---------------------------------------------------------------- Chinese
function buildChinese() {
  const zhVocab = ["1", "2", "3", "4", "5", "6", "7"].flatMap((f) =>
    (JSON.parse(readFileSync(join(RAW, `hsk/new-${f}.json`), "utf8")) as any[]).map((w) =>
      String(w.s ?? ""),
    ),
  );
  const zhPicker = new ExamplePicker("zh", onlyKnownHan(loadTatoeba(RAW, "zh"), zhVocab));
  const longerZh = longerIn(zhVocab.filter(Boolean));
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
    for (const it of items)
      Object.assign(it, zhPicker.pick([it.term], [], longerZh(it.term)) ?? {});
    writeList(
      {
        id: `zh-hsk-${file === "7" ? "7-9" : file}`,
        lang: "zh",
        name: `Chinese · HSK 3.0 level ${level}`,
        level: `HSK ${level}`,
        source:
          "HSK 3.0 word lists: drkameleon/complete-hsk-vocabulary (lists from elkmovie/hsk30; definitions from CC-CEDICT via MDBG); ordered by its frequency rank" +
          EX_SOURCE,
        license: "MIT (complete-hsk-vocabulary); CC BY-SA 4.0 (CC-CEDICT definitions)" + EX_LICENSE,
      },
      items,
    );
  }
}

// ---------------------------------------------------------------- frequency + Wiktionary
/** top: Wiktionary topics (heraldry, Buddhism, chemistry…). */
type KSense = { g: string; tags: string[]; of: string[]; top?: string[] };
/** hj: has a hanja spelling (Sino-Korean); f: conjugated forms (Korean verbs/adjectives). */
type KEntry = {
  w: string;
  pos: string;
  senses: KSense[];
  hj?: number;
  f?: string[];
  /** Wiktionary usage examples: [text, English, sense index] */
  ex?: [string, string, number][];
};

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
  "root",
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
/** Closed-class parts of speech whose sense goes first (adverbs excluded: schön is "beautiful" before "well"). */
const FIRST_POS = new Set([...FUNCTION_POS].filter((p) => p !== "adv"));
/** Never shown: slurs and the like, plus senses a learner should not meet first. */
const BAD_TAGS = new Set([
  "offensive",
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
  // insults (바보 "fool", idiot): their only meaning, but never over a neutral one
  "derogatory",
  "pejorative",
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
/**
 * Korean marks speech levels with these tags (너 "you" is informal, 저 "I" is
 * humble): that is register, not slang, so it does not hide a sense.
 */
const KO_NEUTRAL_TAGS = new Set([
  "informal",
  "colloquial",
  "formal",
  "polite",
  "humble",
  "honorific",
]);
/** English definitions: "mommy" is "mother" even though Wiktionary tags it childish. */
const EN_NEUTRAL_TAGS = new Set(["informal", "colloquial", "childish"]);
const BAD_GLOSS = /\b(ethnic slur|derogatory|offensive|pejorative)\b/i;
const SOFT_GLOSS = /^(short for|clipping of)\b/i;
/** Wiktionary notes that are not meanings. */
/**
 * Specialist topics: such a sense is not what a learner meets first in a
 * frequency list (parti "per pale" in heraldry, 팔고 "eight Duḥkhas" in
 * Buddhism). Those senses go last, an entry with only those ranks last, and a
 * Sino-Korean entry with only those is dropped.
 */
const TECH_TOPICS = new Set(
  // only clearly specialist fields: biology, anatomy, medicine… cover everyday words (cell, liver, lion)
  "heraldry Buddhism Hinduism Taoism Confucianism mysticism tarot astrology alchemy occult card-games chess baseball cricket fencing falconry printing typography organic-chemistry inorganic-chemistry biochemistry mineralogy crystallography metallurgy prosody phonetics phonology linguistics statistics logic rhetoric music-theory taxonomy mycology entomology ichthyology ornithology".split(
    " ",
  ),
);
const isTech = (s: KSense) => !!s.top?.some((t) => TECH_TOPICS.has(t));
const JUNK_GLOSS =
  /^(?:\p{Lu}\p{Ll}+ \(language\)$|indicating a surname|\S+ (?:\([^)]*\) )?\+ -?\S+(?: \([^)]*\))?$|(?:figurative|literal|other|primarily \w+) senses?\b|senses relating\b|.*\b(?:in various|in all|in any) senses?\.?$|see the entry at|only used in|more information|hanja forms?:)/iu;
const FORM_TAGS = new Set([
  "form-of",
  "alt-of",
  "abbreviation",
  "initialism",
  "acronym",
  "misspelling",
]);
const FORMISH_GLOSS =
  /^(alternative|allomorph|prevocalic|elided|elision|apocopated|apocope|contracted|syncopated|clitic|enclitic|proclitic|obsolete|archaic|dated|nonstandard|informal|eye dialect|pronunciation|misspelling|abbreviation|initialism|contraction|clipping|apocopic|apheretic|plural|singular|feminine|masculine|inflection|diminutive|augmentative|superlative|comparative|gerund|past|present|imperative|first|second|third|simple|infinitive|form|elative|supine|nominative|genitive|dative|accusative|instrumental|prepositional|short|neuter|definite|indefinite|romanization|synonym|topic-marked|object-marked|subject-marked|future|realis|irrealis|determiner|adnominal)\b.*\bof\b/i;
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
 * Hand-written backs for a few top-frequency words whose Wiktionary entry
 * only has a descriptive definition ("The most common adverb of negation…"),
 * or whose most common use is not the one the data puts first. Keep this
 * tiny; everything else comes from the data.
 */
const OVERRIDES: Record<string, Record<string, string>> = {
  fr: {
    pas: "not (with ne); (noun) step, pace",
    vous: "you (plural or formal)",
    nous: "we; us",
    du: "some (partitive); of the",
    se: "oneself, himself, herself, itself, themselves; each other",
    bien: "well; good, fine; (noun) good, property",
    là: "there; here; then",
    plein: "full; (prep) all over",
    tour: "turn; tour, trip; (noun) tower",
  },
  es: { bien: "well; very; (noun) good, property" },
  pt: { tu: "you (informal singular)" },
  it: { bene: "well; fine, OK; (noun) good, property", ora: "now; (noun) hour" },
  de: {
    sein: "to be; (det) his, its",
    der: "the (masculine); (pron) who, that; he",
    ja: "yes; (particle) of course, after all",
    für: "for",
    wer: "who; (pron) whoever, someone",
    sich: "oneself, himself, herself, itself, themselves; each other",
  },
  ru: {
    это: "this, that, it; this is, that is",
    бы: "would (conditional particle)",
    есть: "there is, there are; is; (verb) to eat",
    то: "then; that (thing)",
  },
  ko: {
    네: "yes; your (= 너의)",
    예: "yes; (noun) example",
    내: "my (= 나의); (noun) inside, within",
    제: "my (humble, = 저의); (noun) memorial rite",
    이다: "to be (the copula: A is B)",
    못: "cannot, unable to; (noun) nail",
    안: "not; (noun) inside",
  },
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

/**
 * Pronoun/determiner forms are words a learner needs in their own right, and
 * Wiktionary spells out their meaning after the lemma: "accusative of yo: me",
 * "apocopic form of mío, my", "genitive of 나 (na, “I, me”)". Turn those into
 * plain senses ("me", "my", "I, me").
 */
function functionFormSense(e: KEntry, s: KSense): KSense | null {
  if (!s.of.length || !/^(pron|det|article)$/.test(e.pos)) return null;
  if (s.tags.some((t) => BAD_TAGS.has(t))) return null;
  const tags = s.tags.filter((t) => !FORM_TAGS.has(t));
  const quoted = /\bof \S+ \([^,()]*, “([^”]+)”\)\s*$/.exec(s.g);
  if (quoted) return { g: quoted[1], tags, of: [] };
  const m = /\bof [^\s:,;.]+(?: [^\s:,;.]+)?\s*[:,;.]\s*(.+)$/.exec(s.g);
  const g = m?.[1]
    .replace(/\s*\([^()]*\)/g, "")
    .replace(/\.$/, "")
    .trim();
  // "apocopic form of quello used before a consonant" is a usage note, not a meaning
  if (g && /^used\b/i.test(g)) return null;
  if (!g || /\bof\b/.test(g) || g.length > 40 || /[“”()]/.test(g)) return null;
  return { g, tags, of: [] };
}

/** Lemma senses (non-form-of, non-obsolete) of an entry. */
function lemmaSenses(e: KEntry, soft = false, lang = ""): string[] {
  if (BAD_POS.has(e.pos)) return [];
  // Korean verb/adjective entries not ending in 다 describe an inflected form (하지만 "does, but")
  if (lang === "ko" && /^(verb|adj)$/.test(e.pos) && !e.w.endsWith("다")) return [];
  const ok = e.senses
    .filter((s) => !(lang === "ko" && e.hj && isTech(s)))
    .map((s) => functionFormSense(e, s) ?? s)
    .filter(
      (s) =>
        !s.of.length &&
        !s.tags.some((t) => FORM_TAGS.has(t)) &&
        !FORMISH_GLOSS.test(s.g) &&
        !JUNK_GLOSS.test(s.g) &&
        !/\b(abbreviation|initialism|acronym|interrogative form) of\b/i.test(s.g) &&
        !/\b(?:indicative|subjunctive|participle|imperative|infinitive|gerund) of\b/i.test(s.g) &&
        !/\b(?:form|forms|inflection|determiner|determinative|adnominal) of (?!address)/i.test(
          s.g,
        ) &&
        !/^(?:a |the )?(?:name of |letter |surname)/i.test(s.g) &&
        !/^the (?:\w+ )?(?:script )?letter\b/i.test(s.g) &&
        !/\bspelling\b.*\bof\b|\bjamo\b|\bGreek letter\b|\bnumeral symbol\b|\bletter of the .*alphabet\b|\bMC reading\b|\bsound (?:expressed|represented) by the letter\b|\beumhun\b/i.test(
          s.g,
        ),
    );
  const soft_ = (t: string) =>
    SOFT_TAGS.has(t) &&
    !(lang === "ko" && KO_NEUTRAL_TAGS.has(t)) &&
    !(lang === "en" && EN_NEUTRAL_TAGS.has(t)) &&
    // a pronoun's register is not slang (ça "that" is informal)
    !((FUNCTION_POS.has(e.pos) || e.pos === "intj") && /^(informal|colloquial)$/.test(t));
  const good = ok.filter(
    (s) =>
      !s.tags.some((t) => BAD_TAGS.has(t)) &&
      !BAD_GLOSS.test(s.g) &&
      !/^\((?:obsolete|archaic|rare|dated)\)/i.test(s.g),
  );
  const neutral = good.filter((s) => !s.tags.some(soft_) && !SOFT_GLOSS.test(s.g));
  // specialist senses never count as the neutral meaning; as a fallback they go last
  const plain = (soft ? good : neutral).filter((s) => !isTech(s));
  const kept = plain.length || !soft ? plain : good;
  return kept.map((s) => cleanGloss(s.g)).filter(Boolean);
}
/** Every sense of the entry is specialist (see TECH_TOPICS). */
const techOnly = (e: KEntry) =>
  e.senses.some((s) => !s.of.length) && e.senses.filter((s) => !s.of.length).every(isTech);

type FormRef = { base: string; g: string; tags: string[]; pos: string };

/** Lemmas this entry is a form of, with the form's own description. */
function formRefs(e: KEntry, lang: string): FormRef[] {
  if (BAD_POS.has(e.pos)) return [];
  return e.senses
    .filter((s) => s.of.length && s.tags.some((t) => t === "form-of" || t === "alt-of"))
    .flatMap((s) =>
      s.of.map((w) => ({
        base: lang === "ru" ? stripStress(w) : w,
        g: s.g,
        tags: s.tags,
        pos: e.pos,
      })),
    );
}
const formTargets = (e: KEntry, lang: string) => formRefs(e, lang).map((r) => r.base);

type Resolved = { term: string; back: string } | null;

/**
 * Which entry leads the back. Wiktionary lists a word's main etymology and
 * main part of speech first, so entry order is the main signal (maison is
 * the noun "house" before the adjective "homemade"; petit is the adjective
 * before the noun "little one"). A much richer later entry can still win
 * (es bien adv "well" over adj; tour and fr bien need OVERRIDES). Pronouns,
 * articles and other closed-class entries go first (pas "not" before "step");
 * conjunctions only weakly (aussi is "too", not "therefore"). Verbs get a
 * small boost (devenir "to become" before the noun "future"). Entries that
 * only have slang/informal senses, and Korean Sino-Korean homonyms (hanja
 * entries), rank after plain native ones.
 */
const POS_WEIGHT: Record<string, number> = { verb: 5, noun: 1, adj: 1 };
/** Conjunctions and particles lead only when Wiktionary lists them first (ob, oder; not aussi "therefore"). */
const WEAK_FIRST = new Set(["conj", "particle"]);
const rankEntry = (e: {
  pos: string;
  n: number;
  ord: number;
  hj?: number;
  soft?: boolean;
  desc?: boolean;
  tech?: boolean;
  ordReal?: number;
  lang?: string;
}) =>
  (FIRST_POS.has(e.pos) && !e.hj && !e.desc
    ? WEAK_FIRST.has(e.pos) && (e.ordReal ?? e.ord) > 0
      ? 3
      : 1000
    : 0) +
  (e.desc ? -4 : 0) +
  (POS_WEIGHT[e.pos] ?? 0) +
  // Korean Sino-Korean noun/adverb pairs (당장, 직접, 계속) are used as adverbs
  (e.lang === "ko" && e.pos === "adv" ? 5 : 0) +
  0.5 * Math.min(e.n, 8) -
  3 * e.ord -
  (e.hj ? 3 : 0) -
  (e.soft ? 4 : 0) -
  (e.tech ? 4 : 0);

/** Descriptive definitions ("The most common adverb of …") read badly on a card. */
const descriptive = (g: string) =>
  /^(used|denotes|indicates|expresses|attaches)\b/i.test(g)
    ? 2
    : /^\p{Lu}/u.test(g) && g.replace(/\s*\([^)]*\)/g, "").split(" ").length >= 4
      ? 1
      : 0;

type RawEntry = { pos: string; senses: string[]; hj?: number; soft?: boolean; tech?: boolean };

function makeBack(raw: RawEntry[], term = "", lang = ""): string {
  const entries = raw.map((e, ord) => {
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
    // an entry whose best sense is still a description (que: "The inanimate
    // subject interrogative pronoun"; journal adj "That is relative to each day")
    const desc = parts.length > 0 && descriptive(parts[0]) > 0;
    // Korean: adjectives are verbs of state (크다 "to be big" vs verb "to grow")
    const pos = lang === "ko" && e.pos === "adj" ? "verb" : e.pos;
    return {
      pos,
      lang,
      label: e.pos,
      senses: parts,
      n: e.senses.length,
      ord,
      hj: e.hj,
      soft: e.soft,
      tech: e.tech,
      desc,
    };
  });
  // function words first: "pas" → adverb "not" before noun "step"
  const withSenses = entries
    .filter((e) => e.senses.length)
    .map((e, ord, all) => ({
      ...e,
      ord,
      // position among real (non-descriptive) entries, for the weak closed-class bonus
      ordReal: all.slice(0, ord).filter((o) => !o.desc).length,
    }))
    .sort((a, b) => rankEntry(b) - rankEntry(a) || a.ord - b.ord);
  if (process.env.WORDS_RANK === term)
    console.error(
      withSenses.map((e) => [e.pos, e.ord, e.soft, e.desc, e.tech, rankEntry(e), e.senses[0]]),
    );
  if (!withSenses.length) return "";
  const first = withSenses[0];
  const parts: string[] = [first.senses[0]];
  const firstPos = first.pos;
  const seenPos = new Set([firstPos]);
  for (const e of withSenses.slice(1)) {
    if (seenPos.has(e.pos)) continue;
    if (parts.some((p) => p.replace(/^\([^)]*\) /, "").toLowerCase() === e.senses[0].toLowerCase()))
      continue;
    // Korean Sino-Korean homonyms of another part of speech are mostly noise
    if (lang === "ko" && e.hj && !first.hj) continue;
    seenPos.add(e.pos);
    const label = POS_LABEL[e.label] ?? e.label;
    parts.push(`(${label}) ${e.senses[0]}`);
  }
  // fill with further senses of the leading entry, then the main sense of
  // homonyms with the same part of speech (livre "book"; "pound")
  const extra = [
    first.senses[0],
    ...withSenses
      .filter(
        (e) => e !== first && e.pos === firstPos && !e.desc && !e.soft && !e.tech && lang !== "ko",
      )
      .map((e) => e.senses[0]),
    ...first.senses.slice(1),
  ];
  const head = parts.slice(0, 1);
  const tail = parts.slice(1);
  return joinSenses([...head, ...extra.slice(1, 3), ...tail].slice(0, 6), 80, 3);
}

/**
 * English backs are definitions, not translations. English Wiktionary lists
 * the main etymology and the main sense first, so keep that order and take
 * the first definition, plus a second part of speech when it fits.
 */
function makeBackEn(raw: RawEntry[]): string {
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

/**
 * A token that is a lemma in its own right AND a form of a very common word
 * (est = "east" / "is", été = "summer" / "been"). The form leads when its
 * lemma is among the top ~400 tokens and the form is a common one (not a
 * subjunctive or literary tense); the token's own meaning follows.
 */
const COMMON_BASE_RANK = 400;
const RARE_FORM = /\b(subjunctive|pluperfect|past historic|conditional|future|anterior)\b/i;

/** "third-person singular present indicative of être" → "3rd sg. present of être". */
function shortForm(g: string): string {
  return stripStress(g)
    .replace(/\s*\([^()]*\)/g, "")
    .replace(/:$/, "")
    .replace(/^inflection of\b/i, "form of")
    .replace(/\bfirst\/third-person\b/g, "1st/3rd")
    .replace(/\bfirst\/second-person\b/g, "1st/2nd")
    .replace(/\bfirst-person\b/g, "1st")
    .replace(/\bsecond-person\b/g, "2nd")
    .replace(/\bthird-person\b/g, "3rd")
    .replace(/\bsingular\b/g, "sg.")
    .replace(/\bplural\b/g, "pl.")
    .replace(/\bpresent indicative\b/g, "present")
    .replace(/\s*\bindicative\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The leading sense of a back, without a "(noun)" label, cut to a short phrase. */
const headSense = (back: string, max = 28) => {
  const s = back.split("; ")[0].replace(/^\([^)]*\) /, "");
  const c = s.split(/, /)[0];
  return c.length <= max ? c : "";
};

function buildFrequencyLang(lang: string, dict: Map<string, KEntry[]>) {
  const scriptOk = SCRIPT[lang] ?? LATIN;
  const lines = readFileSync(join(RAW, `freq/${lang}_50k.txt`), "utf8").split("\n");
  const rank = new Map<string, number>();
  const count = new Map<string, number>();
  lines.forEach((l, i) => {
    const [w0, c] = l.split(" ");
    const w = w0?.toLowerCase();
    if (w && !rank.has(w)) {
      rank.set(w, i);
      count.set(w, Number(c) || 0);
    }
  });
  const rankOf = (w: string) => rank.get(w.toLowerCase()) ?? Infinity;
  const senses = (e: KEntry, soft = false) => lemmaSenses(e, soft, lang);

  const pick = (word: string): KEntry[] => {
    const all = dict.get(word.toLowerCase()) ?? [];
    const exact = all.filter((e) => e.w === word);
    if (lang === "en" && word === "i") return all.filter((e) => e.w === "I");
    const usable = exact.some((e) => senses(e, true).length || formTargets(e, lang).length);
    // German: lowercase subtitle tokens of nouns (zeit) should reach the noun
    // (Zeit) unless the lowercase word is itself a verb, adjective or pronoun.
    const deNoun =
      lang === "de" &&
      // (nor when it is an adverb/interjection — ja, hier, nein — or a form of a common verb: habe → haben)
      !exact.some((e) => !/^(noun|prep)$/.test(e.pos) && senses(e, true).length) &&
      !exact.some((e) =>
        // (a form of a verb more frequent than the token itself; tag → Tag "day", not tagen)
        formTargets(e, lang).some(
          (t) => (rank.get(t.toLowerCase()) ?? Infinity) < (rank.get(word.toLowerCase()) ?? 0),
        ),
      ) &&
      all.some(
        (e) =>
          e.w === word[0].toUpperCase() + word.slice(1) &&
          e.pos === "noun" &&
          // a noun, or a plural/case form of one (tage → Tage → Tag)
          (senses(e).length > 0 || formTargets(e, lang).length > 0),
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
      const score = es.reduce(
        (n, e) => n + senses(e, true).length + (formTargets(e, lang).length ? 0.5 : 0),
        0,
      );
      if (score > bestScore) {
        best = es;
        bestScore = score;
      }
    }
    return best;
  };
  const backOf = (es: KEntry[], soft: boolean) => {
    // an entry with only informal senses still counts (ça is a pronoun), ranked lower
    const raw = es.map((e) => {
      const neutral = senses(e, soft);
      const tech = techOnly(e);
      if (neutral.length || soft) return { pos: e.pos, senses: neutral, hj: e.hj, tech };
      return { pos: e.pos, senses: senses(e, true), hj: e.hj, soft: true, tech };
    });
    return lang === "en" ? makeBackEn(raw) : makeBack(raw, es[0].w, lang);
  };
  const glossOf = (word: string, only?: (e: KEntry) => boolean): Resolved => {
    let es = pick(word);
    if (only) es = es.filter(only);
    if (!es.length) return null;
    const back = OVERRIDES[lang]?.[es[0].w] || backOf(es, false) || backOf(es, true);
    return back ? { term: es[0].w, back } : null;
  };
  /** Fold a form into its lemma (one more hop if the lemma is itself a form). */
  const foldTo = (targets: string[]): Resolved => {
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
  };
  const enNameLike = (w: string) => {
    const cap = w[0].toUpperCase() + w.slice(1);
    const all = dict.get(w) ?? [];
    // a first name or a place (a bare surname is too common: Hospital, Necessary)
    const personOrPlace = /\b(given name|a city|capital (?:city )?of|a country in)\b/i;
    if (
      !all.some(
        (e) => e.w === cap && e.pos === "name" && e.senses.some((x) => personOrPlace.test(x.g)),
      )
    )
      return false;
    const own = all.filter((e) => e.w === w);
    if (own.some((e) => (FUNCTION_POS.has(e.pos) || e.pos === "adj") && senses(e, true).length))
      return false;
    // common nouns show up in the plural too (winners, clerks, cliffs); names rarely do
    if (rank.has(w + "s") || rank.has(w + "es")) return false;
    return own.reduce((k, e) => k + senses(e, true).length, 0) <= 2;
  };
  const isFunctionWord = (w: string) =>
    pick(w).some((e) => FUNCTION_POS.has(e.pos) && senses(e, true).length);

  const resolveGeneric = (word: string): Resolved[] => {
    // a hand-written back is the whole card (ru есть "there is"; its lemma быть counts anyway)
    const over = OVERRIDES[lang]?.[word];
    if (over && pick(word).length) return [{ term: word, back: over }];
    const es = pick(word);
    if (!es.length) return [];
    const lemmaEntries = es.filter((e) => senses(e, true).length);
    const hasFunctionLemma = lemmaEntries.some((e) => FUNCTION_POS.has(e.pos));
    let refs = es
      .flatMap((e) => formRefs(e, lang))
      .filter((r) => r.base.toLowerCase() !== word.toLowerCase());
    // A form of a rare word (terre, also a form of the rare verb terrer) is
    // just itself.
    if (lemmaEntries.length) refs = refs.filter((r) => rankOf(r.base) < 10000);
    // A particle that is also a form of a top verb (ru было "nearly" / "was")
    // is a homograph like the ones below; other function words stay themselves.
    const verbRef = (r: FormRef) =>
      r.pos === "verb" &&
      rankOf(r.base) < COMMON_BASE_RANK &&
      !RARE_FORM.test(r.g) &&
      !r.tags.some((t) => RARE_FORM.test(t));
    const particleHomograph =
      hasFunctionLemma &&
      lemmaEntries.every((e) => !FUNCTION_POS.has(e.pos) || e.pos === "particle") &&
      refs.some(verbRef);
    if (particleHomograph) refs = refs.filter(verbRef);
    if (!refs.length || (hasFunctionLemma && !particleHomograph)) {
      const r = glossOf(word);
      return r ? [r] : [];
    }
    const base = foldTo(refs.map((r) => r.base));
    // Pure inflections (sont, fue) fold into their lemma, and so do forms
    // whose own meaning is only slang (Tage "period", besides "days").
    if (!lemmaEntries.length || !lemmaEntries.some((e) => senses(e).length))
      return base ? [base] : [];
    // Homographs: a lemma in its own right that is also a form of another
    // word (été "summer" / "been", casa "house" / form of casar). Both count.
    // Forms of pronouns and determiners (essa, einen, meus) are the function
    // word, so they fold, unless the token is a verb in its own right (meinen).
    const own = glossOf(word, (e) => senses(e, true).length > 0);
    const ownVerb = lemmaEntries.some((e) => e.pos === "verb");
    const fnRef = refs.find((r) => isFunctionWord(r.base));
    if (fnRef && !ownVerb) return base ? [base] : own ? [own] : [];
    if (!own) return base ? [base] : [];
    if (!base) return [own];
    const ref = refs.find((r) => r.base.toLowerCase() === base.term.toLowerCase()) ?? refs[0];
    const ownEs = pick(word).filter((e) => senses(e, true).length);
    const ownPos = (ownEs.find((e) => senses(e).length) ?? ownEs[0]).pos;
    // A noun that hardly occurs in the plural (pienso "fodder", pasa "raisin")
    // is much rarer than the verb form it spells; casas, nuits, portes are common.
    const plural =
      /^(fr|es|pt)$/.test(lang) && ownPos === "noun" && !/[sxz]$/.test(word)
        ? word + (lang === "es" && !/[aeiouáéíóú]$/.test(word) ? "es" : "s")
        : "";
    const unattested = !!plural && rankOf(plural) > 20 * Math.max(rankOf(word), 50);
    const formFirst =
      (rankOf(ref.base) < COMMON_BASE_RANK || (unattested && rankOf(ref.base) < 3000)) &&
      !RARE_FORM.test(ref.g) &&
      !ref.tags.some((t) => RARE_FORM.test(t)) &&
      // a German infinitive that is also an adjective ending (lieben, heißen) is the verb
      !(ownVerb && ref.pos !== "verb");
    // an own meaning that is only a usage note (pt será "used to indicate doubt") is the form
    if (!formFirst && descriptive(own.back.split("; ")[0]) === 2) return [base];
    if (!formFirst) return [own, base];
    let desc = shortForm(ref.g);
    if (!/:\s/.test(desc)) {
      const hs = headSense(base.back);
      if (hs && hs.toLowerCase() !== base.term.toLowerCase()) desc += ` (“${hs}”)`;
    } else desc = desc.replace(/:\s+/, ": ");
    // a descriptive own sense ("A spice made from …") is not worth the space
    const ownParts = own.back.split("; ").filter((p, i) => i > 0 || !descriptive(p));
    if (!ownParts.length) return [{ term: own.term, back: desc }, base];
    const labelled = ownParts[0].startsWith("(")
      ? ownParts
      : [`(${POS_LABEL[ownPos] ?? ownPos}) ${ownParts[0]}`, ...ownParts.slice(1)];
    // keep the token's own meaning visible: shorten the form note, then the meaning
    if (desc.length + labelled[0].length + 2 > 80) desc = shortForm(ref.g);
    const room = 80 - desc.length - 2;
    if (labelled[0].length > room) labelled[0] = room >= 12 ? truncate(labelled[0], room) : "";
    const back = joinSenses([desc, ...labelled], 80, 3);
    return [{ term: own.term, back }, base];
  };

  const resolve =
    lang === "ko"
      ? koreanResolver(dict, pick, senses, glossOf, resolveGeneric, rank, count)
      : resolveGeneric;

  const out: Entry[] = [];
  const seen = new Set<string>();
  const TARGET = 3000;
  // every token that resolved to a term, for finding example sentences (팔고 → 팔다)
  const formsOfTerm = new Map<string, Set<string>>();
  const FORM_SCAN = 30000;
  for (const [li, line] of lines.entries()) {
    if (li >= FORM_SCAN) break;
    const full = out.length >= TARGET;
    const word = line.split(" ")[0]?.trim();
    if (!word) continue;
    if (!scriptOk.test(word) || /['’-]$/.test(word)) continue;
    if (lang === "en" && EN_JUNK.has(word)) continue; // pieces of contractions
    // English subtitle tokens are lowercased names too (kyle, vega, berlin):
    // skip a word that is a name when its common-noun entry is thin
    if (lang === "en" && enNameLike(word)) continue;
    let rs = resolve(word).filter((r): r is NonNullable<Resolved> => !!r);
    if ([...word].length < 2 && lang !== "ko") {
      // single letters are mostly subtitle junk; keep real one-letter words
      // (à, y, и) or inflections of a lemma (pt é → ser)
      const isFunction = pick(word).some((e) => FUNCTION_POS.has(e.pos) && senses(e).length);
      if (!isFunction) rs = rs.filter((r) => r.term.toLowerCase() !== word.toLowerCase());
    }
    if (process.env.WORDS_DEBUG && rs.length && !full)
      console.error(`${word}\t${rs.map((r) => r.term).join(" + ")}`);
    for (const r of rs) {
      const key = r.term.toLowerCase();
      let fs = formsOfTerm.get(key);
      if (!fs) formsOfTerm.set(key, (fs = new Set()));
      fs.add(word.toLowerCase());
      if (full || seen.has(key)) continue;
      seen.add(key);
      out.push({ term: r.term, back: r.back });
    }
  }
  // one example per entry: Wiktionary's own usage example when one fits,
  // else the shortest Tatoeba sentence with the word or one of its forms
  const picker = new ExamplePicker(lang, loadTatoeba(RAW, lang));
  for (const e of out) {
    const key = e.term.toLowerCase();
    const forms = new Set([key, ...(formsOfTerm.get(key) ?? [])]);
    // examples of the main senses only; hand-written backs pick a sense the data may not lead with
    // and only from the entry whose sense the back leads with (maison "house",
    // not the adjective "in-house"; pick the noun "pickaxe", not the verb)
    const lead = e.back.split("; ")[0].replace(/^\([^)]*\) /, "");
    const wikt = OVERRIDES[lang]?.[e.term]
      ? []
      : pick(e.term)
          .filter((k) => !(lang === "ko" && k.hj))
          .filter((k) => senses(k, true).some((g) => g.startsWith(lead) || lead.startsWith(g)))
          .flatMap((k) => (k.ex ?? []).filter((x) => x[2] <= 2));
    // Wiktionary's example illustrates the sense; a much shorter Tatoeba one still wins
    const w = wiktionaryExample(lang, wikt, forms);
    const t =
      w && w.ex.length <= 60
        ? null
        : picker.pick(
            [key],
            [...forms].filter((f) => f !== key),
          );
    const ex: Example | null = w && (!t || w.ex.length <= t.ex.length + 20) ? w : t;
    if (ex) Object.assign(e, ex);
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
        source: `Ranks: hermitdave/FrequencyWords (OpenSubtitles 2018, ${lang}_50k); glosses: English Wiktionary via kaikki.org (${name} extract), inflected forms folded into lemmas${EX_SOURCE_WIKT}`,
        license: "CC BY-SA 4.0 (FrequencyWords; Wiktionary content, also GFDL)" + EX_LICENSE,
      },
      out.slice(b * 500, (b + 1) * 500),
    );
  }
}

/**
 * Korean tokens are eojeol: 팔고 is 팔다 "to sell" + -고, but Wiktionary
 * also has a rare noun 팔고 "eight Duḥkhas". Each token is analysed as
 *   1. a pronoun with a fused particle (난 = 나 + 는, 널 = 너 + 를),
 *   2. a conjugated verb/adjective (conjugation tables + regular endings),
 *   3. a noun + particle or copula (사람이, 거야),
 * and checked against the token's own entry:
 *   - a native adverb/pronoun/determiner/interjection (그리고, 우리, 잘) is
 *     just itself — the analysis is not trusted over it;
 *   - a native noun (해 "sun", 말 "speech") is itself when it also occurs with
 *     particles of its own (해가, 말을); otherwise the analysis wins;
 *   - a Sino-Korean noun (보고 "report") is kept after the analysis only with
 *     that evidence, so 팔고, 대한 "great khan" and 할 "a tenth" are dropped.
 */
/** 것 + copula, contracted (할 거야, 갈 건데): the word is 것 "thing". */
const KO_GEOT = new Set(
  "거야 거예요 거지 거죠 건데 겁니다 겁니까 건가 건가요 건지 거라고 거니 거냐 거란 거잖아".split(
    " ",
  ),
);
/** Contractions of 아니다 "to not be" (아냐 = 아니야). */
const KO_ANI = new Set("아냐 아녜요 아님 아닌 아닌데 아닌가 아닐".split(" "));
const KO_COPULA = new Set(
  "이야 이에요 예요 입니다 입니까 이다 였어 였어요 였다 이었어 이었어요 이었다 였습니다 이었습니다 이지 이죠 인데 이라고 이라는 이니까 이면".split(
    " ",
  ),
);
function koreanResolver(
  dict: Map<string, KEntry[]>,
  pick: (w: string) => KEntry[],
  senses: (e: KEntry, soft?: boolean) => string[],
  glossOf: (w: string, only?: (e: KEntry) => boolean) => Resolved,
  resolveGeneric: (w: string) => Resolved[],
  rank: Map<string, number>,
  count: Map<string, number>,
) {
  // form → verb/adjective lemmas, scored by how often their forms occur;
  // forms straight from a Wiktionary table are trusted more than built ones
  const formsOf = new Map<string, Set<string>>();
  const weight = new Map<string, number>();
  for (const es of dict.values())
    for (const e of es) {
      if (!e.f || !(e.pos === "verb" || e.pos === "adj") || e.w === "이다") continue;
      if (!lemmaSenses(e, true, "ko").length) continue;
      let wsum = 0;
      for (const f of verbForms(e.w, e.f)) {
        if (!rank.has(f)) continue;
        // a form that is also a word of its own (나 "I" is also the infinitive of 나다) is no evidence
        if (
          !(dict.get(f) ?? []).some(
            (o) => o.pos !== "verb" && o.pos !== "adj" && !BAD_POS.has(o.pos),
          )
        )
          wsum += count.get(f) ?? 0;
        let s = formsOf.get(f);
        if (!s) formsOf.set(f, (s = new Set()));
        s.add(e.w);
      }
      weight.set(e.w, (weight.get(e.w) ?? 0) + wsum);
    }
  const lemmaEs = (w: string) => pick(w).filter((e) => senses(e, true).length);
  const nounish = /^(noun|pron|num|det|counter)$/;
  const evidence = (w: string) => NOUN_EVIDENCE.filter((p) => rank.has(w + p)).length;
  const isNative = (e: KEntry) => !e.hj;

  return (word: string): Resolved[] => {
    if (KO_COPULA.has(word)) return [glossOf("이다")];
    if (KO_GEOT.has(word)) return resolveGeneric("것");
    if (KO_ANI.has(word)) return [glossOf("아니다")];
    // 왜요, 저기요: a polite 요 on an adverb, interjection or pronoun
    if (word.length > 1 && word.endsWith("요")) {
      const st = word.slice(0, -1);
      if (lemmaEs(st).some((e) => /^(adv|intj|pron)$/.test(e.pos) && !e.hj))
        return resolveGeneric(st);
    }
    let own = lemmaEs(word);
    // a lone Sino-Korean syllable (서 "west", 사 "four") is usually a piece of
    // a longer word or an ending in subtitles; keep it only when attested as a noun
    if ([...word].length === 1 && own.every((e) => e.hj) && evidence(word) < 3) own = [];
    // 1. pronoun + fused particle (난, 넌, 널, 걸 → 거)
    const fused = unfuse(word);
    if (
      fused &&
      pick(fused).some((e) => e.pos === "pron" || (e.pos === "noun" && /^(거|것)$/.test(fused)))
    )
      if (!own.some((e) => isNative(e) && (e.pos !== "noun" || evidence(word) >= 2)))
        return resolveGeneric(fused);
    // 2./3. verb form, else noun + particle
    const verbLemmas = [...(formsOf.get(word) ?? [])].sort(
      (a, b) => (weight.get(b) ?? 0) - (weight.get(a) ?? 0),
    );
    let noun = "";
    for (const st of stripParticles(word)) {
      const ok =
        lemmaEs(st).some((e) => nounish.test(e.pos)) ||
        pick(st).some((e) => /^(noun|pron)$/.test(e.pos) && formTargets(e, "ko").length);
      if (ok && (!noun || (rank.get(st) ?? Infinity) < (rank.get(noun) ?? Infinity))) noun = st;
    }
    // 우리는 is 우리 + 는, not a form of 우리다: the more frequent reading wins
    const verbScore = verbLemmas.length
      ? (weight.get(verbLemmas[0]) ?? 0) - (count.get(word) ?? 0)
      : -1;
    const nounScore = noun ? (count.get(noun) ?? 0) : -1;
    const analysis: Resolved[] = [];
    if (verbLemmas.length && verbScore >= nounScore) analysis.push(glossOf(verbLemmas[0]));
    else if (noun) analysis.push(...resolveGeneric(noun).slice(0, 1));
    const ownR = own.length ? resolveGeneric(word) : [];
    if (!analysis.some(Boolean)) return ownR;
    if (!ownR.length) return analysis;
    // a dictionary-form verb, or a native function word / adverb, is itself
    if (own.some((e) => /^(verb|adj)$/.test(e.pos) && e.w.endsWith("다"))) return ownR;
    // (Sino-Korean adverbs too: 절대 "absolutely", 만약 "if")
    if (
      own.some(
        (e) =>
          (isNative(e) || /^(adv|intj|pron|det|conj)$/.test(e.pos)) &&
          !/^(noun|verb|adj)$/.test(e.pos),
      )
    )
      return ownR;
    const ev = evidence(word) >= (own.some((e) => e.pos === "noun" && isNative(e)) ? 2 : 3);
    if (own.some((e) => e.pos === "noun" && isNative(e))) {
      if (!ev) return analysis;
      const native = glossOf(word, (e) => !e.hj && senses(e, true).length > 0);
      return native ? [native] : ownR;
    }
    if (!ev) return analysis;
    // a well-attested noun (문 "door": 문을, 문이, 문은 …) leads
    return evidence(word) >= 5 ? [...ownR, ...analysis] : [...analysis, ...ownR];
  };
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
