#!/usr/bin/env bun
/**
 * Build the English exam decks served from public/words/ for /words:
 * `en-exam-*.json` (中考, 高考, CET-4, CET-6, 考研), `en-ngsl.json`,
 * `en-nawl.json`, `en-tsl.json`, and their
 * rows in index.json (`kind: "exam"`, `exam`). Other lists are left alone.
 * What each part of a card comes from: scripts/words/exam-decks.ts (top).
 *
 * Reproduce (RAW = any scratch dir OUTSIDE the repo; downloads are only parsed):
 *
 *   RAW=/tmp/exam-raw; mkdir -p $RAW/tatoeba
 *   # 1. ECDICT (MIT): exam tags, COCA/BNC ranks, word forms
 *   curl -sfL -o $RAW/ecdict.csv https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv
 *   # 2. NGSL project lists 1.2 (CC BY-SA 4.0), with their frequency ranks
 *   for f in NGSL_12_stats NAWL_12_stats TSL_12_stats; do
 *     curl -sfL -A Mozilla/5.0 -o $RAW/$f.csv https://www.newgeneralservicelist.com/s/$f.csv
 *   done
 *   # 3. The words the decks hold, then their English-Wiktionary entries
 *   #    (kaikki.org, CC BY-SA 4.0): Mandarin translations, IPA, glosses
 *   bun scripts/words/build-exam-decks.ts --words $RAW > $RAW/exam-words.txt
 *   curl -sL https://kaikki.org/dictionary/English/kaikki.org-dictionary-English.jsonl.gz | gunzip \
 *     | bun scripts/words/filter-kaikki-zh.ts $RAW/exam-words.txt > $RAW/kaikki-en-zh.jsonl
 *   # 4. Tatoeba English sentences with their authors (CC BY 2.0 FR)
 *   curl -sfL https://downloads.tatoeba.org/exports/per_language/eng/eng_sentences_detailed.tsv.bz2 \
 *     | bunzip2 > $RAW/tatoeba/eng_sentences_detailed.tsv
 *   # 5. Build. Words with no Mandarin translation in Wiktionary take their
 *   #    meaning from scripts/words/exam-glosses.tsv; any still missing are
 *   #    written to $RAW/need-glosses.tsv (word, part of speech, English glosses).
 *   bun scripts/words/build-exam-decks.ts $RAW public/words
 *
 * No IELTS, TOEFL or GRE deck: those exams publish no word list, so any list
 * is a prep-book compilation (docs/word-deck-sources.md, "Not shipped").
 *
 * Sources, licences and attribution: docs/word-deck-sources.md and
 * public/words/SOURCES.md.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as OpenCC from "opencc-js";
import { ExamplePicker, type Sent } from "./examples";
import {
  byFrequency,
  dedupeBack,
  isOffensive,
  mergeExamIndex,
  parseEcdict,
  parseGlosses,
  parseRanked,
  tagged,
  toEntry,
  usesWord,
  wiktBack,
  type EcdictRow,
  type Example,
  type ExampleSource,
  type ExamEntry,
  type ExamListMeta,
  type WiktEntry,
} from "./exam-decks";

const args = process.argv.slice(2);
const wordsOnly = args[0] === "--words";
const [RAW, OUT] = wordsOnly ? args.slice(1) : args;
if (!RAW || (!OUT && !wordsOnly)) {
  console.error("usage: build-exam-decks.ts <raw-dir> <out-dir> | --words <raw-dir>");
  process.exit(1);
}

/** Read a file as UTF-8, or Latin-1 when it is not valid UTF-8 (TSL's "résumé"). */
const readText = (p: string) => {
  const buf = readFileSync(p);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("latin1").decode(buf);
  }
};

const rows = parseEcdict(readText(join(RAW, "ecdict.csv")));
// One row per headword (ECDICT has a few duplicates).
const dict = new Map<string, EcdictRow>();
for (const r of rows) if (!dict.has(r.word)) dict.set(r.word, r);
const ranked = (file: string) => parseRanked(readText(join(RAW, file)));

type Deck = {
  id: string;
  name: string;
  level: string;
  exam: string;
  /** The deck's words, in deck order. */
  words: () => string[];
  source: string;
  license: string;
};
const fromTag =
  (tag: string, except: string[] = []) =>
  () =>
    tagged(rows, tag, except)
      .filter((r) => dict.get(r.word) === r)
      .sort(byFrequency)
      .map((r) => r.word);
const fromRanked = (file: string) => () => ranked(file);

const SOURCE_TAIL =
  "Chinese meanings and IPA: English Wiktionary (en.wiktionary.org) contributors, via kaikki.org; meanings Wiktionary has no Chinese for written for Lianki from its definitions; example sentences: Wiktionary usage examples, then Tatoeba (tatoeba.org), each credited by sentence id and author";
const ECDICT_SOURCE = `Word list and frequency order: the exam tag of ECDICT (skywind3000/ECDICT); ${SOURCE_TAIL}`;
const ECDICT_LICENSE =
  "MIT (ECDICT word list); CC BY-SA 4.0 (Wiktionary content, also GFDL; this deck); CC BY 2.0 FR (Tatoeba sentences)";
const NGSL_SOURCE = (list: string, by: string) =>
  `Word list: ${list} 1.2 by ${by} (newgeneralservicelist.com), in its frequency order; ${SOURCE_TAIL}`;
const NGSL_LICENSE =
  "CC BY-SA 4.0 (NGSL list; Wiktionary content, also GFDL; this deck); CC BY 2.0 FR (Tatoeba sentences)";
const NGSL_BY = "Charles Browne, Brent Culligan and Joseph Phillips";
const TSL_BY = "Charles Browne and Brent Culligan";

const ecdict = { source: ECDICT_SOURCE, license: ECDICT_LICENSE };
const DECKS: Deck[] = [
  {
    id: "en-exam-zk",
    name: "English · 中考 (Zhongkao)",
    level: "中考",
    exam: "中考 · 高考",
    words: fromTag("zk"),
    ...ecdict,
  },
  {
    id: "en-exam-gk",
    name: "English · 高考 (Gaokao)",
    level: "高考",
    exam: "中考 · 高考",
    words: fromTag("gk"),
    ...ecdict,
  },
  {
    id: "en-exam-cet4",
    name: "English · CET-4 (四级)",
    level: "CET-4",
    exam: "CET 四六级",
    words: fromTag("cet4"),
    ...ecdict,
  },
  {
    id: "en-exam-cet6",
    name: "English · CET-6 (六级, beyond CET-4)",
    level: "CET-6",
    exam: "CET 四六级",
    words: fromTag("cet6", ["cet4"]),
    ...ecdict,
  },
  {
    id: "en-exam-ky",
    name: "English · 考研 (NEEP)",
    level: "考研",
    exam: "考研",
    words: fromTag("ky"),
    ...ecdict,
  },
  {
    id: "en-tsl",
    name: "English · TOEIC Service List",
    level: "TOEIC",
    exam: "TOEIC",
    words: fromRanked("TSL_12_stats.csv"),
    source: NGSL_SOURCE("TOEIC Service List (TSL)", TSL_BY),
    license: NGSL_LICENSE,
  },
  {
    id: "en-ngsl",
    name: "English · NGSL core words",
    level: "NGSL",
    exam: "NGSL",
    words: fromRanked("NGSL_12_stats.csv"),
    source: NGSL_SOURCE("New General Service List (NGSL)", NGSL_BY),
    license: NGSL_LICENSE,
  },
  {
    id: "en-nawl",
    name: "English · NAWL academic words",
    level: "NAWL",
    exam: "NGSL",
    words: fromRanked("NAWL_12_stats.csv"),
    source: NGSL_SOURCE("New Academic Word List (NAWL)", NGSL_BY),
    license: NGSL_LICENSE,
  },
];

if (wordsOnly) {
  const all = new Set(DECKS.flatMap((d) => d.words()));
  console.log([...all].sort().join("\n"));
  process.exit(0);
}

// Wiktionary entries by word (several per word: one per part of speech).
const wikt = new Map<string, WiktEntry[]>();
for (const line of readFileSync(join(RAW, "kaikki-en-zh.jsonl"), "utf8").split("\n")) {
  if (!line) continue;
  const e = JSON.parse(line) as WiktEntry;
  const list = wikt.get(e.word) ?? [];
  list.push(e);
  wikt.set(e.word, list);
}
const glossPath = join(import.meta.dir, "exam-glosses.tsv");
const written = parseGlosses(readFileSync(glossPath, "utf8"));

/** Sentences found on cards in review: untrue as fact, or crude in context. */
const SKIP_EXAMPLES = new Set(["Evolution is a lie.", "I provide escorts.", "I'm a dominant top."]);
// Tatoeba English sentences with their ids and authors; none that offend.
type Credit = { id: string; by?: string };
const credit = new Map<string, Credit>();
const sents: Sent[] = [];
for (const line of readFileSync(join(RAW, "tatoeba/eng_sentences_detailed.tsv"), "utf8").split(
  "\n",
)) {
  const [id, , text, by] = line.split("\t");
  if (
    !id ||
    !text ||
    text.length > 80 ||
    credit.has(text) ||
    isOffensive(text) ||
    SKIP_EXAMPLES.has(text)
  )
    continue;
  credit.set(text, { id, ...(by && by !== "\\N" ? { by } : {}) });
  sents.push({ s: text, en: "", words: text.split(/\s+/).length });
}
const picker = new ExamplePicker("en", sents);
const credited = (ex: string): Example => {
  const c = credit.get(ex);
  return c
    ? { ex, exSrc: `tatoeba:${c.id}`, ...(c.by ? { exBy: c.by } : {}) }
    : { ex, exSrc: "wiktionary" };
};
// The sentence an English frequency list already gives the word, when it is
// fine to show; else the shortest Tatoeba sentence with the word or a form.
const known = new Map<string, string>();
for (let i = 1; i <= 6; i++) {
  const f = JSON.parse(readFileSync(join(OUT, `en-freq-${i}.json`), "utf8"));
  for (const e of f.entries as { term: string; ex?: string }[])
    if (e.ex && !known.has(e.term) && !isOffensive(e.ex) && !SKIP_EXAMPLES.has(e.ex))
      known.set(e.term, e.ex);
}
const picked = new Map<string, Example | undefined>();
const examples: ExampleSource = (word, forms) => {
  if (!picked.has(word)) {
    // the frequency list's sentence may use a word it was folded into
    // ("I'm a temp." for temperature): only one with the word itself counts
    const k = known.get(word);
    const ok = (ex?: string) => !!ex && usesWord(ex, word, forms);
    const p = ok(k) ? k : [picker.pick([word], forms)?.ex, picker.pick([word], [])?.ex].find(ok);
    picked.set(word, p ? credited(p) : undefined);
  }
  return picked.get(word);
};
// Wiktionary's tables mix traditional and simplified; the backs are simplified.
const toSimplified = OpenCC.Converter({ from: "t", to: "cn" });

/** Wiktionary glosses that say a word is not a lemma of its own. */
const STRAY =
  /misspelling|obsolete|archaic|nonstandard|dated|alternative (form|spelling)|plural of|form of|past (tense|participle) of|third-person|present participle/i;
/** Prefixes some lists carry as words; they are not cards. */
const AFFIXES = new Set([
  "trans",
  "micro",
  "semi",
  "multi",
  "neo",
  "non",
  "pre",
  "anti",
  "sub",
  "inter",
]);
const lookupWikt = (w: string) => wikt.get(w) ?? wikt.get(w.toLowerCase()) ?? [];
const need = new Map<string, string>();
const metas: ExamListMeta[] = [];
for (const d of DECKS) {
  const entries: ExamEntry[] = [];
  const missing: string[] = [];
  for (const word of d.words()) {
    const w = lookupWikt(word);
    const r = dict.get(word);
    // A word the source tags but no corpus ranks, with no Mandarin in
    // Wiktionary, whose Wiktionary entry calls it a misspelling, an old or
    // nonstandard form, or a plural (uptodate, reservior, attent, bones): no
    // card. Rare real words (abnegate, adulate) stay. The NGSL lists are
    // curated, so their words always stay.
    const obscure =
      d.id.startsWith("en-exam-") &&
      !(r?.frq || r?.bnc) &&
      !wiktBack(w) &&
      (!w.length || w.every((x) => x.glosses.every((g) => !g || STRAY.test(g))));
    const e =
      AFFIXES.has(word) || obscure
        ? null
        : toEntry({ word, wikt: w, written: written.get(word), forms: r?.forms ?? [] }, examples);
    // OpenCC keeps 著 (土著, 著名); in 着急 and 睡着 it is the traditional 着
    if (e)
      entries.push({
        ...e,
        back: dedupeBack(
          toSimplified(e.back)
            .replace(/著急/g, "着急")
            .replace(/睡著/g, "睡着"),
        ),
      });
    else {
      missing.push(word);
      if (w.length && !AFFIXES.has(word) && !obscure)
        need.set(
          word,
          w.map((x) => `${x.pos}: ${x.glosses.filter(Boolean).join(" | ")}`).join(" || "),
        );
    }
  }
  const file = `${d.id}.json`;
  const meta = { id: d.id, lang: "en", name: d.name, level: d.level, source: d.source };
  writeFileSync(
    join(OUT, file),
    JSON.stringify({ ...meta, license: d.license, kind: "exam", exam: d.exam, entries }),
  );
  metas.push({
    ...meta,
    kind: "exam",
    exam: d.exam,
    count: entries.length,
    file,
    license: d.license,
  });
  const withEx = entries.filter((e) => e.ex).length;
  const wr = entries.filter((e) => written.get(e.term) === e.back).length;
  console.log(
    `${d.id.padEnd(16)} ${String(entries.length).padStart(5)}  ex ${Math.round((100 * withEx) / Math.max(1, entries.length))}%  written ${wr}` +
      (missing.length ? `  dropped ${missing.length} (${missing.slice(0, 12).join(", ")})` : ""),
  );
}
if (need.size) {
  writeFileSync(
    join(RAW, "need-glosses.tsv"),
    [...need].map(([w, g]) => `${w}\t${g}`).join("\n") + "\n",
  );
  console.log(`${need.size} words need a written meaning: ${join(RAW, "need-glosses.tsv")}`);
}

const indexPath = join(OUT, "index.json");
const existing = JSON.parse(readFileSync(indexPath, "utf8")).lists;
const lists = mergeExamIndex(existing, metas);
writeFileSync(indexPath, JSON.stringify({ lists }));
console.log(`index.json: ${lists.length} lists`);
