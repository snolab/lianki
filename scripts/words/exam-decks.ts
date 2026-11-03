/**
 * Exam word decks (CET-4/6, 考研, TOEFL, IELTS, GRE, NGSL, TOEIC …): the
 * downloaded sources → list files and index.json rows. Pure, so the tests run
 * it on fixtures; the CLI is build-exam-decks.ts. Sources and licences:
 * docs/word-deck-sources.md.
 */

/** One ECDICT row (skywind3000/ECDICT, MIT), only the columns we use. */
export type EcdictRow = {
  word: string;
  phonetic: string;
  translation: string;
  tag: string;
  bnc: number;
  frq: number;
  /** Inflected forms ("abandoned abandoning abandons"), from ECDICT's exchange column. */
  forms: string[];
};

export type ExamEntry = { term: string; reading?: string; back: string; ex?: string };

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

/** Parse a CSV file (RFC 4180 quotes; ECDICT keeps newlines inside fields as `\n`). */
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
 * → the word's own inflections. "0:" and "1:" point to a lemma and are skipped.
 */
export function formsOf(exchange: string): string[] {
  const out = new Set<string>();
  for (const part of exchange.split("/")) {
    const m = /^([pdi3srt]):(.+)$/.exec(part.trim());
    if (m && /^[a-z'-]+$/.test(m[2])) out.add(m[2]);
  }
  return [...out];
}

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
      phonetic: r[1] ?? "",
      translation: r[3] ?? "",
      tag: r[7] ?? "",
      bnc: Number(r[8]) || 0,
      frq: Number(r[9]) || 0,
      forms: formsOf(r[10] ?? ""),
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

const POS: Record<string, string> = { a: "adj", s: "adj" };

/**
 * ECDICT's Chinese translation → a short back: "(vt.) 放弃，抛弃，遗弃；(n.) 放任".
 * Lines tagged with a field ("[医] …", "[计] …", "[网络] …") are dropped, at
 * most three senses per part of speech and three parts of speech are kept.
 * The part of speech is in brackets, so the meaning read aloud
 * (lib/words/say-parts.ts meaningText) starts with the first sense.
 */
export function chineseBack(translation: string, maxLen = 48): string {
  const lines = translation
    .split(/\\n|\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("["));
  // senses per part of speech, in first-seen order; a repeated line ("n. 上下文") adds nothing
  const byPos = new Map<string, string[]>();
  for (const line of lines) {
    const m = /^([a-z]+)\.\s*(.*)$/.exec(line);
    const pos = m ? (POS[m[1]] ?? m[1]) : "";
    const body = (m ? m[2] : line).replace(/\s*\[[^\]]*\]\s*/g, " ");
    const senses = byPos.get(pos) ?? [];
    for (const s of body.split(/\s*[,;，；]\s*/).map((x) => x.trim()))
      if (s && !senses.includes(s)) senses.push(s);
    if (senses.length) byPos.set(pos, senses);
  }
  const parts = [...byPos]
    .slice(0, 3)
    .map(([pos, senses]) => `${pos ? `(${pos}.) ` : ""}${senses.slice(0, 3).join("，")}`);
  let back = "";
  for (const p of parts) {
    const next = back ? `${back}；${p}` : p;
    if (back && next.length > maxLen) break;
    back = next;
  }
  return back;
}

/**
 * ECDICT's phonetic (old British dictionary notation, "ә'bændәn") → IPA
 * between slashes ("/əˈbændən/"). Empty when there is none.
 */
const IPA_OK = /^[a-zˈˌəːɒæʃʌʒɑŋθɛɔðɪʊɜɚ() -]+$/;

export function ipa(phonetic: string): string {
  const p = phonetic
    .trim()
    .replace(/ә/g, "ə")
    .replace(/'/g, "ˈ")
    .replace(/^[.,]|(?<=[^\s])[.,](?=\S)/g, "ˌ")
    .replace(/ɡ/g, "g")
    .replace(/[єε]/g, "ɛ")
    .replace(/:/g, "ː");
  // anything else is noise in the source ("^", "\\", "@"): no reading rather than a wrong one
  return p && IPA_OK.test(p) ? `/${p}/` : "";
}

/** Frequency order: COCA rank (ECDICT frq), then BNC rank, then the rest A→Z. */
export function byFrequency(a: EcdictRow, b: EcdictRow): number {
  const ka = a.frq || a.bnc || Infinity;
  const kb = b.frq || b.bnc || Infinity;
  if (ka !== kb) return ka - kb;
  return a.word < b.word ? -1 : a.word > b.word ? 1 : 0;
}

/** Where a card's example sentence comes from: the word and its forms → a sentence, or none. */
export type ExampleSource = (word: string, forms: string[]) => string | undefined;

/** A row → a card with its Chinese meaning, IPA and an example sentence. */
export function toEntry(r: EcdictRow, examples: ExampleSource): ExamEntry | null {
  const back = chineseBack(r.translation);
  if (!back) return null;
  const reading = ipa(r.phonetic);
  const ex = examples(r.word, r.forms);
  return { term: r.word, ...(reading ? { reading } : {}), back, ...(ex ? { ex } : {}) };
}

/** Rows carrying an ECDICT tag (cet4, gre …), minus any word carrying an `except` tag. */
export function tagged(rows: EcdictRow[], tag: string, except: string[] = []): EcdictRow[] {
  return rows.filter((r) => {
    const tags = r.tag.split(" ");
    return tags.includes(tag) && !except.some((t) => tags.includes(t)) && isHeadword(r.word);
  });
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

/**
 * Cards for a word list in its own order, with Chinese meanings from ECDICT.
 * A word ECDICT has no usable entry for is skipped and reported.
 */
export function rankedEntries(
  words: string[],
  lookup: (word: string) => EcdictRow | undefined,
  examples: ExampleSource,
): { entries: ExamEntry[]; missing: string[] } {
  const entries: ExamEntry[] = [];
  const missing: string[] = [];
  for (const w of words) {
    const r = lookup(w);
    const e = r ? toEntry({ ...r, word: w }, examples) : null;
    if (e) entries.push(e);
    else missing.push(w);
  }
  return { entries, missing };
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
