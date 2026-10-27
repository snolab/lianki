/**
 * Example sentences for word-list entries: one short sentence that uses the
 * word, with its English translation. Sources, in order of preference:
 *   1. Wiktionary usage examples (kaikki `ex`), which illustrate a sense;
 *   2. Tatoeba sentences with an English translation (CC BY 2.0 FR).
 * Downloads are untrusted data: only split and compared, never executed.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Example = { ex: string; exTr?: string };
type Sent = { s: string; en: string; words: number };

/** ISO 639-3 codes Tatoeba uses for its per-language exports. */
export const TATOEBA_CODE: Record<string, string> = {
  fr: "fra",
  es: "spa",
  de: "deu",
  en: "eng",
  ko: "kor",
  it: "ita",
  pt: "por",
  ru: "rus",
  ja: "jpn",
  zh: "cmn",
};

const MAX_EX = 80;
const MAX_TR = 100;

let english: Map<string, string> | null = null;
function englishSentences(raw: string): Map<string, string> {
  if (english) return english;
  english = new Map();
  const p = join(raw, "tatoeba/eng_sentences.tsv");
  if (!existsSync(p)) return english;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const [id, , text] = line.split("\t");
    if (id && text && text.length <= MAX_TR) english.set(id, text);
  }
  return english;
}

/** Tatoeba sentences of a language (≤ 80 chars) with their shortest English translation. */
export function loadTatoeba(raw: string, lang: string): Sent[] {
  const code = TATOEBA_CODE[lang];
  const sp = join(raw, `tatoeba/${code}_sentences.tsv`);
  if (!code || !existsSync(sp)) return [];
  const isEn = lang === "en";
  const tr = new Map<string, string>();
  if (!isEn) {
    const eng = englishSentences(raw);
    const lp = join(raw, `tatoeba/${code}-eng_links.tsv`);
    if (!existsSync(lp)) return [];
    for (const line of readFileSync(lp, "utf8").split("\n")) {
      const [a, b] = line.split("\t");
      const t = b && eng.get(b);
      if (!t) continue;
      const prev = tr.get(a);
      if (!prev || t.length < prev.length) tr.set(a, t);
    }
  }
  const out: Sent[] = [];
  const seen = new Set<string>();
  for (const line of readFileSync(sp, "utf8").split("\n")) {
    const [id, , text] = line.split("\t");
    if (!id || !text || text.length > MAX_EX || seen.has(text)) continue;
    const en = isEn ? "" : tr.get(id);
    if (en === undefined) continue;
    seen.add(text);
    out.push({ s: text, en, words: text.split(/\s+/).length });
  }
  return out;
}

const SPACELESS = new Set(["ja", "zh"]);
/** Words of a sentence, lowercased; Korean keeps whole eojeol. */
export const wordsOf = (s: string) =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter(Boolean);

/**
 * Finds the shortest natural sentence that contains a word or one of its
 * forms. A sentence already used for another entry costs extra, so the
 * list does not repeat one sentence everywhere.
 */
export class ExamplePicker {
  private byWord = new Map<string, number[]>();
  private byGram = new Map<string, number[]>();
  private used = new Map<number, number>();
  constructor(
    private lang: string,
    private sents: Sent[],
  ) {
    sents.forEach((x, i) => {
      if (SPACELESS.has(lang)) {
        const chars = [...x.s];
        const grams = new Set<string>();
        for (let k = 0; k < chars.length; k++) {
          grams.add(chars[k]);
          if (k + 1 < chars.length) grams.add(chars[k] + chars[k + 1]);
        }
        for (const g of grams) push(this.byGram, g, i);
      } else for (const w of new Set(wordsOf(x.s))) push(this.byWord, w, i);
    });
  }

  private cost(i: number, exact: boolean, termLen: number): number {
    const x = this.sents[i];
    const len = [...x.s].length;
    let c = len + 15 * (this.used.get(i) ?? 0) - (exact ? 8 : 0);
    // too short to show the word in use ("Merci !", "그래.")
    if (SPACELESS.has(this.lang) ? len < termLen + 4 : x.words < 3) c += 1000;
    return c;
  }

  /**
   * `exact` forms (the term itself) are preferred over inflected `forms`.
   * For Japanese and Chinese, `longer` are list words that contain the term:
   * an occurrence inside one of them (白 in 面白い, 问 in 疑问) does not count.
   */
  pick(exact: string[], forms: string[], longer: string[] = []): Example | null {
    let best = -1;
    let bestCost = Infinity;
    const consider = (i: number, isExact: boolean, termLen: number) => {
      const c = this.cost(i, isExact, termLen);
      if (c < bestCost) {
        bestCost = c;
        best = i;
      }
    };
    const all = [...exact.map((f) => [f, true] as const), ...forms.map((f) => [f, false] as const)];
    for (const [f0, isExact] of all) {
      const f = f0.toLowerCase();
      if (!f) continue;
      if (SPACELESS.has(this.lang)) {
        const chars = [...f];
        const key = chars.length >= 2 ? chars[0] + chars[1] : chars[0];
        for (const i of this.byGram.get(key) ?? [])
          if (standsAlone(this.sents[i].s, f, longer)) consider(i, isExact, chars.length);
      } else
        for (const i of this.byWord.get(f) ?? [])
          // (German capitalises every noun, so the test would reject Woche)
          if (this.lang === "de" || !asName(this.sents[i].s, f)) consider(i, isExact, f.length);
    }
    if (best < 0 || bestCost >= 1000) return null;
    this.used.set(best, (this.used.get(best) ?? 0) + 1);
    const x = this.sents[best];
    return x.en ? { ex: x.s, exTr: x.en } : { ex: x.s };
  }
}

/** A lowercase word that only appears capitalised mid-sentence is a name there (Me llamo Marina). */
function asName(s: string, f: string): boolean {
  if (f !== f.toLowerCase() || f === f.toUpperCase()) return false;
  const ws = s.split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
  const hits = ws.map((w, i) => [w, i] as const).filter(([w]) => w.toLowerCase() === f);
  return hits.length > 0 && hits.every(([w, i]) => i > 0 && w !== f);
}

/** Some occurrence of `f` in `s` is not covered by a longer word containing it. */
function standsAlone(s: string, f: string, longer: string[]): boolean {
  const covered: [number, number][] = [];
  for (const l of longer)
    for (let p = s.indexOf(l); p >= 0; p = s.indexOf(l, p + 1)) covered.push([p, p + l.length]);
  for (let p = s.indexOf(f); p >= 0; p = s.indexOf(f, p + 1))
    if (!covered.some(([a, b]) => a <= p && p + f.length <= b)) return true;
  return false;
}

function push(m: Map<string, number[]>, k: string, v: number) {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

/**
 * The first Wiktionary example (in sense order) that reads as a sentence,
 * fits on a card, has a translation (except for English), and contains the
 * word or one of its forms.
 */
export function wiktionaryExample(
  lang: string,
  examples: [string, string, number][],
  forms: Set<string>,
): Example | null {
  for (const [text0, tr] of examples) {
    // Russian examples carry stress marks (ви́дел); learners' texts do not
    const text = text0
      .normalize("NFD")
      .replace(/\u0301/g, "")
      .normalize("NFC");
    if (text.length > MAX_EX || tr.length > MAX_TR) continue;
    // a literary quotation with its source in the translation ("… (M. Yu. Lermontov)")
    if (/\([^)]*\b\p{Lu}\.[^)]*\)\s*$/u.test(tr) || /\d/.test(tr)) continue;
    // a sentence, not a phrase or a label ("15세 관람 가")
    if (!/[.!?。？！…]["»”’)]*$/u.test(text) || /\d/.test(text)) continue;
    if (lang !== "en" && !tr) continue;
    const ws = wordsOf(text);
    if (ws.length < 3) continue;
    if (!ws.some((w) => forms.has(w))) continue;
    return lang === "en" ? { ex: text } : { ex: text, exTr: tr };
  }
  return null;
}
