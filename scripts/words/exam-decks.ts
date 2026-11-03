/**
 * Exam word decks (CET-4/6, 考研, TOEFL, IELTS, GRE, NGSL, TOEIC …): the
 * downloaded sources → list files and index.json rows. Pure, so the tests run
 * it on fixtures; the CLI is build-exam-decks.ts. Sources and licences:
 * docs/word-deck-sources.md.
 *
 * What comes from where:
 * - which words an exam deck holds, their frequency ranks and their inflected
 *   forms: ECDICT (MIT), columns `tag`, `frq`, `bnc`, `exchange` only;
 * - Chinese meanings and IPA: English Wiktionary (CC BY-SA 4.0) via kaikki.org,
 *   its translation tables into Mandarin and its pronunciation sections;
 * - meanings for words Wiktionary has no Mandarin translation for: written
 *   for Lianki from the word's Wiktionary definitions (scripts/words/exam-glosses.tsv);
 * - example sentences: the English frequency lists' sentence, else Tatoeba
 *   (CC BY 2.0 FR), each credited by sentence id and author.
 */

/** One ECDICT row (skywind3000/ECDICT, MIT), only the columns we use. */
export type EcdictRow = {
  word: string;
  tag: string;
  bnc: number;
  frq: number;
  /** Inflected forms ("abandoned abandoning abandons"), from the exchange column. */
  forms: string[];
  /** The lemma when this row is itself an inflection ("drugs" → "drug"), from exchange "0:". */
  lemma?: string;
};

/** One kaikki.org English-Wiktionary entry (one part of speech), only what we use. */
export type WiktEntry = {
  word: string;
  pos: string;
  /** Mandarin translations, in sense order: "放棄 /放弃" (traditional / simplified) or "工具". */
  tr: { w: string; s: string; tags?: string[] }[];
  ipa: { ipa: string; tags: string[] }[];
  /** The first gloss of the first senses (English), for meanings written by hand. */
  glosses: string[];
};

export type ExamEntry = {
  term: string;
  reading?: string;
  back: string;
  ex?: string;
  /** Where the example comes from: "tatoeba:<id>" or "wiktionary". */
  exSrc?: string;
  /** The Tatoeba sentence's author (CC BY 2.0 FR asks for it). */
  exBy?: string;
};

export type ExamListMeta = {
  id: string;
  lang: string;
  name: string;
  level: string;
  kind: "exam";
  /** The exam the deck prepares for; the /words picker groups decks by it. */
  exam: string;
  count: number;
  file: string;
  source: string;
  license: string;
};

/** Parse a CSV file (RFC 4180 quotes). */
export function* csvRows(s: string): Generator<string[]> {
  let i = 0;
  const n = s.length;
  while (i < n) {
    const row: string[] = [];
    for (;;) {
      let f = "";
      if (s[i] === '"') {
        i++;
        for (;;) {
          if (i >= n) break;
          if (s[i] === '"') {
            if (s[i + 1] === '"') {
              f += '"';
              i += 2;
            } else {
              i++;
              break;
            }
          } else f += s[i++];
        }
      }
      while (i < n && s[i] !== "," && s[i] !== "\n") f += s[i++];
      row.push(f.replace(/\r$/, ""));
      if (s[i] === ",") {
        i++;
        continue;
      }
      i++;
      break;
    }
    yield row;
  }
}

/**
 * ECDICT's exchange column ("p:abandoned/d:abandoned/i:abandoning/3:abandons")
 * → the word's own inflections and, for an inflected row ("0:drug"), its lemma.
 */
export function exchangeOf(exchange: string): { forms: string[]; lemma?: string } {
  const forms = new Set<string>();
  let lemma: string | undefined;
  for (const part of exchange.split("/")) {
    const m = /^([pdi3srt0]):(.+)$/.exec(part.trim());
    if (!m || !/^[a-z'-]+$/.test(m[2])) continue;
    if (m[1] === "0") lemma = m[2];
    else forms.add(m[2]);
  }
  return { forms: [...forms], ...(lemma ? { lemma } : {}) };
}

/** ECDICT rows that carry any tag or rank (the only ones a deck can use). */
export function parseEcdict(text: string): EcdictRow[] {
  const out: EcdictRow[] = [];
  let header = true;
  for (const r of csvRows(text)) {
    if (header) {
      header = false;
      continue;
    }
    if (!r[0]) continue;
    out.push({
      word: r[0],
      tag: r[7] ?? "",
      bnc: Number(r[8]) || 0,
      frq: Number(r[9]) || 0,
      ...exchangeOf(r[10] ?? ""),
    });
  }
  return out;
}

/**
 * A headword worth a card: a lowercase English word (hyphen or apostrophe
 * allowed). Proper names (Africa), abbreviations (B.C., i.e.) and
 * all-caps entries are left out; "I" is the one capital word kept.
 */
export const isHeadword = (w: string) => w === "I" || /^[a-z][a-z'-]*[a-z]$|^[a-z]$/.test(w);

const POS: Record<string, string> = {
  noun: "n",
  verb: "v",
  adj: "adj",
  adv: "adv",
  prep: "prep",
  conj: "conj",
  pron: "pron",
  det: "det",
  article: "art",
  intj: "int",
  num: "num",
  particle: "part",
};

/** "放棄 /放弃" → "放弃": the simplified form when Wiktionary gives both. */
export const simplified = (w: string) => (w.split(/\s*\/\s*/).pop() ?? w).trim();

/**
 * Wiktionary's Mandarin translations of a word → a short back:
 * "(v.) 放弃，遗弃，丢弃；(n.) 工具". Entries (parts of speech) keep
 * Wiktionary's order; inside one, the main (first) sense gives two
 * translations, then each next sense its first, so a second meaning shows
 * before more synonyms but a rare third sense does not crowd out the main. At most
 * three per part of speech, three parts of speech, about `maxLen` characters.
 * The part of speech is in brackets, so the meaning read aloud
 * (lib/words/say-parts.ts meaningText) starts with the first sense.
 */
export function wiktBack(entries: WiktEntry[], maxLen = 48): string {
  const byPos = new Map<string, string[][]>();
  for (const e of entries) {
    const pos = POS[e.pos];
    if (!pos) continue;
    const senses = byPos.get(pos) ?? [];
    const bySense = new Map<string, string[]>();
    for (const t of e.tr) {
      const w = simplified(t.w);
      if (!/\p{Script=Han}/u.test(w) || w.length > 8) continue;
      const list = bySense.get(t.s) ?? [];
      list.push(w);
      bySense.set(t.s, list);
    }
    senses.push(...bySense.values());
    if (senses.length) byPos.set(pos, senses);
  }
  const parts: string[] = [];
  for (const [pos, senses] of [...byPos].slice(0, 3)) {
    // the main sense's first two translations, then the next senses' first
    const picked: string[] = [];
    const add = (w?: string) => w && !picked.includes(w) && picked.length < 3 && picked.push(w);
    senses[0].slice(0, 2).forEach(add);
    for (const s of senses.slice(1)) add(s[0]);
    senses[0].slice(2).forEach(add);
    parts.push(`(${pos}.) ${picked.join("，")}`);
  }
  return joinParts(parts, maxLen);
}

/** Parts of a back, joined with "；" while they fit in `maxLen` (always the first). */
export function joinParts(parts: string[], maxLen = 48): string {
  let back = "";
  for (const p of parts) {
    const next = back ? `${back}；${p}` : p;
    if (back && next.length > maxLen) break;
    back = next;
  }
  return back;
}

/**
 * A pronunciation from Wiktionary: the British one (UK, RP) when there is one,
 * as Chinese exam books use, else the first. Only a plain /…/ transcription.
 */
export function wiktIpa(entries: WiktEntry[]): string {
  const all = entries.flatMap((e) => e.ipa).filter((x) => /^\/[^/]+\/$/.test(x.ipa));
  const uk = all.find((x) => x.tags.some((t) => /^(UK|Received-Pronunciation|British)$/.test(t)));
  return (uk ?? all[0])?.ipa ?? "";
}

/** Frequency order: COCA rank (ECDICT frq), then BNC rank, then the rest A→Z. */
export function byFrequency(a: EcdictRow, b: EcdictRow): number {
  const ka = a.frq || a.bnc || Infinity;
  const kb = b.frq || b.bnc || Infinity;
  if (ka !== kb) return ka - kb;
  return a.word < b.word ? -1 : a.word > b.word ? 1 : 0;
}

/**
 * Rows carrying an ECDICT tag (cet4, gre …), minus any word carrying an
 * `except` tag, without names, and without an inflection whose lemma is in
 * the same deck ("drugs" when "drug" is there).
 */
export function tagged(rows: EcdictRow[], tag: string, except: string[] = []): EcdictRow[] {
  const has = (r: EcdictRow) => {
    const tags = r.tag.split(" ");
    return tags.includes(tag) && !except.some((t) => tags.includes(t)) && isHeadword(r.word);
  };
  const picked = rows.filter(has);
  const words = new Set(picked.map((r) => r.word));
  return picked.filter((r) => !r.lemma || r.lemma === r.word || !words.has(r.lemma));
}

/**
 * A ranked list from the NGSL project (NGSL, NAWL, TSL `*_stats.csv`: word,
 * rank, …) in rank order. Excel's TRUE/FALSE are the words true and false.
 */
export function parseRanked(text: string): string[] {
  const out: { w: string; rank: number }[] = [];
  let header = true;
  for (const r of csvRows(text.replace(/^﻿/, ""))) {
    if (header) {
      header = false;
      continue;
    }
    const raw = (r[0] ?? "").trim();
    const rank = Number(r[1]);
    if (!raw || !Number.isFinite(rank)) continue;
    const w = raw === "I" ? raw : raw.toLowerCase();
    out.push({ w, rank });
  }
  const seen = new Set<string>();
  return out
    .sort((a, b) => a.rank - b.rank)
    .map((x) => x.w)
    .filter((w) => !seen.has(w) && seen.add(w));
}

/** `word<TAB>back` lines (comments with #), the meanings written for Lianki. */
export function parseGlosses(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [w, back] = line.split("\t");
    if (w && back?.trim()) out.set(w.trim(), back.trim());
  }
  return out;
}

/** An example sentence and its credit, or nothing. */
export type Example = { ex: string; exSrc: string; exBy?: string };
export type ExampleSource = (word: string, forms: string[]) => Example | undefined;

/** What a card is made from: its word, Wiktionary entries, written meaning, forms. */
export type CardSource = {
  word: string;
  wikt: WiktEntry[];
  written?: string;
  forms: string[];
};

/**
 * A card: Chinese meaning from Wiktionary's translations, else the written
 * one; IPA from Wiktionary; an example. Null when there is no meaning.
 */
export function toEntry(c: CardSource, examples: ExampleSource): ExamEntry | null {
  const back = wiktBack(c.wikt) || c.written || "";
  if (!back) return null;
  const reading = wiktIpa(c.wikt);
  const ex = examples(c.word, c.forms);
  return { term: c.word, ...(reading ? { reading } : {}), back, ...ex };
}

/** Exam decks replace the old ones of the same language; the other lists keep their place. */
export function mergeExamIndex<T extends { id: string; lang: string; kind?: string }>(
  existing: T[],
  fresh: ExamListMeta[],
): (T | ExamListMeta)[] {
  const langs = new Set(fresh.map((l) => l.lang));
  const kept = existing.filter((l) => !(l.kind === "exam" && langs.has(l.lang)));
  const out: (T | ExamListMeta)[] = [];
  const order = [...new Set([...kept.map((l) => l.lang), ...fresh.map((l) => l.lang)])];
  for (const lang of order) {
    const of = kept.filter((l) => l.lang === lang);
    // after the language's word lists, before its phrase decks
    out.push(...of.filter((l) => l.kind !== "phrase"));
    out.push(...fresh.filter((l) => l.lang === lang));
    out.push(...of.filter((l) => l.kind === "phrase"));
  }
  return out;
}

/**
 * Sentences not to show on a card: profanity, slurs and violence against
 * people. Checked on whole words, case-insensitive.
 */
const OFFENSIVE =
  /\b(fuck\w*|shit\w*|bitch\w*|cunt\w*|dick|dicks|cock|cocks|pussy|whore\w*|slut\w*|bastard\w*|asshole\w*|arse\w*|nigg\w*|fag\w*|retard\w*|rape\w*|raping|porn\w*|sex|sexy|horny|damn\w*|goddamn|piss\w*|wank\w*|kill (yourself|myself|you|him|her)|suicide)\b/i;
export const isOffensive = (s: string) => OFFENSIVE.test(s);
