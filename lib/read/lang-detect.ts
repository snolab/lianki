// The language of a piece of text — a sentence, a paragraph — for a book that
// mixes languages (owner, 2026-11-05: a doc mostly in English with Chinese in
// it; each unit's language drives reading, lookup, translation and 制卡).
//
// One engine, data only (lib/read/lang): a language is known by its script
// (`script` in its file: Han, kana, Hangul, Cyrillic…) or, for scripts many
// languages share (Latin), by its function words (`stop`). No per-language
// branches.
//
// A text's letters are cut into runs (letters and marks, no spaces between).
// Each run belongs to the first language, in the data files' order, whose
// script it uses (so a run with kana is Japanese, a run of Han alone Chinese),
// else to the shared-script bucket. A run weighs one word, or half a word per
// character in scripts where one character is a word (as roughWords). The
// heaviest language wins; the shared-script bucket is named by the function
// words of the whole document (a short sentence has too few of its own).

import { ALONGSIDE, SCRIPT_LANGS, STOP_LANGS } from "./lang";

// Scripts in which one character can be a word: a property of the script.
const CHAR_WORDS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const RUNS = /[\p{L}\p{M}]+/gu;

/** The shared-script bucket's key, before it is named. */
const SHARED = "";

function runsOf(text: string): { run: string; lang: string; w: number }[] {
  const out: { run: string; lang: string; w: number }[] = [];
  for (const m of text.matchAll(RUNS)) {
    const run = m[0];
    const lang = SCRIPT_LANGS.find(([, re]) => re.test(run))?.[0] ?? SHARED;
    const chars = run.match(CHAR_WORDS)?.length ?? 0;
    const w = chars ? chars / 2 + (chars < [...run].length ? 1 : 0) : 1;
    out.push({ run, lang, w });
  }
  return out;
}

/**
 * A text's weight per language (SHARED for runs of no script-language). A
 * run in a script another language writes beside its own (Han beside kana)
 * counts for that language when the text also has its own script.
 */
export function langWeights(text: string): Map<string, number> {
  const runs = runsOf(text);
  const present = new Set(runs.map((r) => r.lang));
  const out = new Map<string, number>();
  for (const r of runs) {
    const host = ALONGSIDE.find(([l, re]) => present.has(l) && re.test(r.run))?.[0];
    const lang = host ?? r.lang;
    out.set(lang, (out.get(lang) ?? 0) + r.w);
  }
  return out;
}

/** Languages that could claim all of a text's letters as their beside-script (a line of Han only: ja, ko). */
function alongsideOnly(text: string): Set<string> {
  const runs = runsOf(text);
  if (!runs.length) return new Set();
  return new Set(ALONGSIDE.filter(([, re]) => runs.every((r) => re.test(r.run))).map(([l]) => l));
}

/** The shared-script language of a document: most function words, else "und". */
export function sharedLang(texts: readonly string[]): string {
  const seen = new Map<string, number>();
  for (const t of texts)
    for (const w of t.toLowerCase().split(/[^\p{L}']+/u))
      if (w) seen.set(w, (seen.get(w) ?? 0) + 1);
  let best = "und";
  let bestN = 0;
  for (const [lang, words] of STOP_LANGS) {
    const n = words.reduce((a, w) => a + (seen.get(w) ?? 0), 0);
    if (n > bestN) [best, bestN] = [lang, n];
  }
  return best;
}

/** One unit's language: the heaviest; null when it has no letters. */
export function unitLang(text: string, shared: string): string | null {
  let best: string | null = null;
  let bestW = 0;
  for (const [l, w] of langWeights(text)) {
    if (w > bestW) [best, bestW] = [l, w];
  }
  if (best === null) return null;
  return best === SHARED ? shared : best;
}

/**
 * Every unit's language, in order. A unit without letters takes the one
 * before it (the first ones, the one after). A run of units between two runs
 * of the same other language, lighter than each of them, takes theirs: an
 * aside ("OK.", a name) is not a change of language.
 */
export function detectLangs(texts: readonly string[], shared = sharedLang(texts)): string[] {
  const raw = texts.map((t) => unitLang(t, shared));
  const firstKnown = raw.find((l) => l !== null) ?? shared;
  const langs: string[] = [];
  for (const l of raw) langs.push(l ?? langs[langs.length - 1] ?? firstKnown);
  // A unit in a beside-script alone (Han) next to a unit of a language that
  // writes it so (Japanese) is that language.
  for (let i = 0; i < texts.length; i++) {
    const may = alongsideOnly(texts[i]);
    if (!may.size) continue;
    const near = [langs[i - 1], langs[i + 1]].find((l) => l !== undefined && may.has(l));
    if (near) langs[i] = near;
  }
  const weight = texts.map((t) => [...langWeights(t).values()].reduce((a, b) => a + b, 0));
  // Runs of one language: [lang, first, end, weight].
  const runs: [string, number, number, number][] = [];
  langs.forEach((l, i) => {
    const r = runs[runs.length - 1];
    if (r && r[0] === l) {
      r[2] = i + 1;
      r[3] += weight[i];
    } else runs.push([l, i, i + 1, weight[i]]);
  });
  // Only a shared-script aside ("OK.", a name in Latin letters) is smoothed: a
  // line written in a language's own script (kana, Hangul) is that language
  // however short — a Japanese line between English ones stays Japanese.
  const ownScript = new Set(SCRIPT_LANGS.map(([l]) => l));
  for (let k = 1; k + 1 < runs.length; k++) {
    const [a, mid, b] = [runs[k - 1], runs[k], runs[k + 1]];
    if (a[0] === b[0] && !ownScript.has(mid[0]) && mid[3] < a[3] && mid[3] < b[3])
      for (let i = mid[1]; i < mid[2]; i++) langs[i] = a[0];
  }
  return langs;
}

/** The primary language of a text: the heaviest over all of it. */
export function primaryLang(texts: readonly string[], shared = sharedLang(texts)): string {
  const total = new Map<string, number>();
  for (const t of texts) for (const [l, w] of langWeights(t)) total.set(l, (total.get(l) ?? 0) + w);
  let best = SHARED;
  let bestW = -1;
  for (const [l, w] of total) if (w > bestW) [best, bestW] = [l, w];
  return best === SHARED ? shared : best;
}

/** Per-line languages as runs [first line, lang], ascending: what a book stores. */
export type LangRuns = [number, string][];

export function toRuns(langs: readonly string[]): LangRuns {
  const out: LangRuns = [];
  langs.forEach((l, i) => {
    if (!out.length || out[out.length - 1][1] !== l) out.push([i, l]);
  });
  return out;
}

/** A line's language from runs (binary search); `fallback` before the first run or without runs. */
export function langAt(
  runs: readonly (readonly [number, string])[] | undefined,
  line: number,
  fallback: string,
): string {
  if (!runs?.length) return fallback;
  let lo = 0;
  let hi = runs.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (runs[mid][0] <= line) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans < 0 ? fallback : runs[ans][1];
}

/** Untrusted runs: ascending integer lines, language tags of 2–3 letters (a subtag). */
export function checkRuns(v: unknown, lineCount: number | null): LangRuns | null {
  if (!Array.isArray(v) || !v.length) return null;
  const out: LangRuns = [];
  for (const r of v) {
    if (!Array.isArray(r) || r.length !== 2) return null;
    const [l, lang] = r;
    if (!Number.isInteger(l) || l < 0 || (lineCount !== null && l >= lineCount)) return null;
    if (typeof lang !== "string" || !/^[a-z]{2,3}$/.test(lang)) return null;
    if (out.length && l <= out[out.length - 1][0]) return null;
    out.push([l, lang]);
  }
  return out;
}

/**
 * A word's (or phrase's) language among a book's languages: the one its
 * script names (or a beside-script, as Han for Japanese), else for a
 * shared-script word the book's first language without a script of its own;
 * else the primary.
 */
export function langIn(text: string, bookLangs: readonly string[], primary: string): string {
  if (bookLangs.length < 2) return primary;
  const runs = runsOf(text);
  if (!runs.length) return primary;
  const scriptLangs = new Set(SCRIPT_LANGS.map(([l]) => l));
  const w = new Map<string, number>();
  for (const r of runs) {
    let l: string | undefined = r.lang;
    if (l && !bookLangs.includes(l))
      l = ALONGSIDE.find(([a, re]) => bookLangs.includes(a) && re.test(r.run))?.[0];
    if (r.lang === SHARED) l = bookLangs.find((b) => !scriptLangs.has(b));
    const k = l ?? primary;
    w.set(k, (w.get(k) ?? 0) + r.w);
  }
  let best = primary;
  let bestW = -1;
  for (const [l, x] of w) if (x > bestW) [best, bestW] = [l, x];
  return best;
}
