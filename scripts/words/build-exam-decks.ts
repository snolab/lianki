#!/usr/bin/env bun
/**
 * Build the English exam decks served from public/words/ for /words:
 * `en-exam-*.json`, `en-ngsl.json`, `en-nawl.json`, `en-tsl.json`, and their
 * rows in index.json (`kind: "exam"`, `exam`). Other lists are left alone.
 *
 * Reproduce (RAW = any scratch dir OUTSIDE the repo; downloads are only parsed):
 *
 *   RAW=/tmp/exam-raw; mkdir -p $RAW
 *   # ECDICT (MIT): exam tags, Chinese meanings, phonetics, COCA/BNC ranks
 *   curl -sfL -o $RAW/ecdict.csv https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv
 *   # NGSL project lists 1.2 (CC BY-SA 4.0), with their frequency ranks
 *   for f in NGSL_12_stats NAWL_12_stats TSL_12_stats; do
 *     curl -sfL -A Mozilla/5.0 -o $RAW/$f.csv https://www.newgeneralservicelist.com/s/$f.csv
 *   done
 *   # Tatoeba English sentences (CC BY 2.0 FR), for example sentences
 *   mkdir -p $RAW/tatoeba
 *   curl -sfL https://downloads.tatoeba.org/exports/per_language/eng/eng_sentences.tsv.bz2 | bunzip2 > $RAW/tatoeba/eng_sentences.tsv
 *   bun scripts/words/build-exam-decks.ts $RAW public/words
 *
 * Example sentences: the one the English frequency lists in public/words
 * (en-freq-*.json) already give a word, else the shortest Tatoeba sentence
 * with the word or one of its forms (scripts/words/examples.ts). Sources, licences
 * and attribution: docs/word-deck-sources.md and public/words/SOURCES.md.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExamplePicker, loadTatoeba } from "./examples";
import {
  byFrequency,
  chineseBack,
  mergeExamIndex,
  parseEcdict,
  parseRanked,
  rankedEntries,
  tagged,
  toEntry,
  type EcdictRow,
  type ExampleSource,
  type ExamEntry,
  type ExamListMeta,
} from "./exam-decks";

const [RAW, OUT] = process.argv.slice(2);
if (!RAW || !OUT) {
  console.error("usage: build-exam-decks.ts <raw-dir> <out-dir>");
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
// One row per headword: the first, which is the lowercase one when ECDICT also has "Polish".
const dict = new Map<string, EcdictRow>();
for (const r of rows) if (!dict.has(r.word)) dict.set(r.word, r);

// Without the accents NGSL's TSL uses (résumé, café), and case-insensitive (north, god).
const fold = (w: string) => w.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const folded = new Map<string, EcdictRow>();
for (const r of rows) {
  const k = fold(r.word);
  const prev = folded.get(k);
  // prefer the lowercase headword, then the one with a meaning
  if (!prev || (prev.word !== k && (r.word === k || !prev.translation))) folded.set(k, r);
}
/**
 * Meanings written for Lianki, for NGSL/TSL words ECDICT has no entry for
 * (newer words). NAWL's prefixes (trans, micro, semi, multi, neo) get no card.
 */
const WRITTEN: Record<string, string> = {
  online: "adj. 在线的，网上的\nadv. 在线，上网",
  reschedule: "vt. 重新安排，改期",
  laptop: "n. 笔记本电脑",
  attendee: "n. 出席者，参加者",
  download: "vt. 下载\nn. 下载",
  affordable: "adj. 买得起的，负担得起的",
  login: "n. 登录，登录名",
  internet: "n. 互联网，因特网",
  donut: "n. 甜甜圈，炸面圈",
  hacker: "n. 黑客，电脑高手",
  paralegal: "n. 律师助理",
  redesign: "vt. 重新设计\nn. 重新设计",
  "by-law": "n. 章程，内部规章，地方法规",
  globalization: "n. 全球化",
  descriptor: "n. 描述词，描述符",
  // not the verb resume, which an accent-blind lookup would find
  résumé: "n. 简历，履历；摘要",
};
const usable = (r: EcdictRow | undefined) => !!r && !!chineseBack(r.translation);
const lookup = (w: string): EcdictRow | undefined => {
  const r = dict.get(w);
  const hit = usable(r) ? r : folded.get(fold(w));
  if (!WRITTEN[w]) return usable(hit) ? hit : undefined;
  const base = dict.get(w);
  return {
    word: w,
    phonetic: base?.phonetic ?? "",
    translation: WRITTEN[w],
    tag: "",
    bnc: 0,
    frq: 0,
    forms: base?.forms ?? [],
  };
};

// Example sentences: the one an English frequency list already gives the word
// (a Wiktionary usage example or a Tatoeba sentence), else the shortest
// Tatoeba sentence with the word or one of its forms.
const known = new Map<string, string>();
for (let i = 1; i <= 6; i++) {
  const f = JSON.parse(readFileSync(join(OUT, `en-freq-${i}.json`), "utf8"));
  for (const e of f.entries as { term: string; ex?: string }[])
    if (e.ex && !known.has(e.term)) known.set(e.term, e.ex);
}
const picker = new ExamplePicker("en", loadTatoeba(RAW, "en"));
const picked = new Map<string, string | undefined>();
const examples: ExampleSource = (word, forms) => {
  if (known.has(word)) return known.get(word);
  if (!picked.has(word)) picked.set(word, picker.pick([word], forms)?.ex);
  return picked.get(word);
};

const ECDICT_SOURCE =
  "Word list: the exam tag of ECDICT (skywind3000/ECDICT); Chinese meanings and phonetics: ECDICT; ordered by COCA/BNC frequency (ECDICT); example sentences: Wiktionary usage examples, then Tatoeba (tatoeba.org)";
const ECDICT_LICENSE =
  "MIT (ECDICT); CC BY-SA 4.0 (Wiktionary examples, also GFDL); CC BY 2.0 FR (Tatoeba sentences)";
const NGSL_SOURCE = (list: string) =>
  `Word list: ${list} 1.2 by Charles Browne, Brent Culligan and Joseph Phillips (newgeneralservicelist.com), in its frequency order; Chinese meanings and phonetics: ECDICT (skywind3000/ECDICT); example sentences: Wiktionary usage examples, then Tatoeba (tatoeba.org)`;
const NGSL_LICENSE =
  "CC BY-SA 4.0 (NGSL lists; this deck); MIT (ECDICT); CC BY 2.0 FR (Tatoeba sentences)";

type Deck = {
  id: string;
  name: string;
  level: string;
  exam: string;
  build: () => { entries: ExamEntry[]; missing?: string[] };
  source: string;
  license: string;
};

const fromTag =
  (tag: string, except: string[] = []) =>
  () => ({
    entries: tagged(rows, tag, except)
      .filter((r) => dict.get(r.word) === r)
      .sort(byFrequency)
      .map((r) => toEntry(r, examples))
      .filter((e): e is ExamEntry => !!e),
  });
const fromRanked = (file: string) => () =>
  rankedEntries(parseRanked(readText(join(RAW, file))), lookup, examples);

const ecdict = { source: ECDICT_SOURCE, license: ECDICT_LICENSE };
const DECKS: Deck[] = [
  {
    id: "en-exam-zk",
    name: "English · 中考 (Zhongkao)",
    level: "中考",
    exam: "中考 · 高考",
    build: fromTag("zk"),
    ...ecdict,
  },
  {
    id: "en-exam-gk",
    name: "English · 高考 (Gaokao)",
    level: "高考",
    exam: "中考 · 高考",
    build: fromTag("gk"),
    ...ecdict,
  },
  {
    id: "en-exam-cet4",
    name: "English · CET-4 (四级)",
    level: "CET-4",
    exam: "CET 四六级",
    build: fromTag("cet4"),
    ...ecdict,
  },
  {
    id: "en-exam-cet6",
    name: "English · CET-6 (六级, beyond CET-4)",
    level: "CET-6",
    exam: "CET 四六级",
    build: fromTag("cet6", ["cet4"]),
    ...ecdict,
  },
  {
    id: "en-exam-ky",
    name: "English · 考研 (NEEP)",
    level: "考研",
    exam: "考研",
    build: fromTag("ky"),
    ...ecdict,
  },
  {
    id: "en-exam-ielts",
    name: "English · IELTS",
    level: "IELTS",
    exam: "IELTS",
    build: fromTag("ielts"),
    ...ecdict,
  },
  {
    id: "en-exam-toefl",
    name: "English · TOEFL",
    level: "TOEFL",
    exam: "TOEFL",
    build: fromTag("toefl"),
    ...ecdict,
  },
  {
    id: "en-exam-gre",
    name: "English · GRE",
    level: "GRE",
    exam: "GRE",
    build: fromTag("gre"),
    ...ecdict,
  },
  {
    id: "en-tsl",
    name: "English · TOEIC Service List",
    level: "TOEIC",
    exam: "TOEIC",
    build: fromRanked("TSL_12_stats.csv"),
    source: NGSL_SOURCE("TOEIC Service List (TSL)"),
    license: NGSL_LICENSE,
  },
  {
    id: "en-ngsl",
    name: "English · NGSL core words",
    level: "NGSL",
    exam: "NGSL",
    build: fromRanked("NGSL_12_stats.csv"),
    source: NGSL_SOURCE("New General Service List (NGSL)"),
    license: NGSL_LICENSE,
  },
  {
    id: "en-nawl",
    name: "English · NAWL academic words",
    level: "NAWL",
    exam: "NGSL",
    build: fromRanked("NAWL_12_stats.csv"),
    source: NGSL_SOURCE("New Academic Word List (NAWL)"),
    license: NGSL_LICENSE,
  },
];

const metas: ExamListMeta[] = [];
for (const d of DECKS) {
  const { entries, missing = [] } = d.build();
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
  console.log(
    `${d.id.padEnd(16)} ${String(entries.length).padStart(5)}  ex ${Math.round((100 * withEx) / Math.max(1, entries.length))}%` +
      (missing.length ? `  no meaning: ${missing.length} (${missing.join(", ")})` : ""),
  );
}

const indexPath = join(OUT, "index.json");
const existing = JSON.parse(readFileSync(indexPath, "utf8")).lists;
const lists = mergeExamIndex(existing, metas);
writeFileSync(indexPath, JSON.stringify({ lists }));
console.log(`index.json: ${lists.length} lists`);
