/**
 * Scenario sentence decks picked from Tatoeba by data, for any language
 * (owner, 2026-11-05: French everyday-life scenario sentences, "目标是
 * survive"). Pure, so the tests run it on fixtures; the CLI is
 * build-scene-sentences.ts, which writes the `<lang>-<scenario>.jsonl`
 * sources that build-phrase-decks.ts turns into decks like the ja/zh ones.
 *
 * - **Scenario:** the concepts of scene-lexicon.ts, matched in the
 *   sentence's English translation, and Tatoeba tags. No per-language code.
 * - **Quality:** written by a native speaker; short (PHRASE_LANG); no digits,
 *   no proper names (a capitalised word inside a sentence), every word in the
 *   language's dictionary when there is one; no crude, figurative, quoted or
 *   unchecked sentence (SKIP_TAGS, isOffensive); no narrative (NARRATIVE).
 *   Repeats, by the sentence or by its English, keep the first in order.
 * - **Order:** easiest first. A sentence's band is the frequency list
 *   (`<lang>-freq-N`, N = 1 for the most common words) of its rarest word;
 *   lower band first, then more useful to survive (USEFUL), then shorter.
 *   Deck sizes follow the data: no count is fixed.
 */
import {
  isScenario,
  phraseLength,
  phraseRule,
  SCENARIOS,
  type Scenario,
} from "@/lib/words/phrases";
import { isOffensive } from "./exam-decks";
import type { CuratedLine } from "./phrase-decks";
import {
  LESS_USEFUL,
  NARRATIVE,
  NOT_CUES,
  SCENE_CUES,
  SKIP_TAG_PREFIX,
  SKIP_TAGS,
  TAG_REGISTER,
  TAG_SCENE,
  USEFUL,
} from "./scene-lexicon";

/** A Tatoeba sentence with its English translation and the tags on both. */
export type Candidate = {
  id: string;
  term: string;
  en: string;
  /** The English translation's Tatoeba id and author, for the credits. */
  enId?: string;
  enBy?: string;
  by: string;
  tags: readonly string[];
  /** First written in this language (sentences_base 0), not translated into it. */
  orig?: boolean;
};

/** What the language's word lists and dictionary know about a word. */
export interface Vocab {
  /** The frequency band of a word or its headword (1 = most common), null when unranked. */
  band(word: string): number | null;
  /** The word is in the dictionary (always true when the language has none). */
  known(word: string): boolean;
  /** The band an unranked known word counts as: after every list. */
  readonly beyond: number;
}

/** English normalised for cue matching: lowercase, straight apostrophes, words space-separated. */
export const normEn = (en: string) =>
  ` ${en
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}'-]+/gu, " ")
    .trim()} `;

/** normEn with the NOT_CUES phrases blanked out, for cue matching. */
const cueText = (en: string) =>
  NOT_CUES.reduce((t, n) => t.replaceAll(` ${n} `, " | "), normEn(en));

/** A cue in cue text: whole words, `^` anchored at the start, `$` at the end. */
export function hasCue(text: string, cue: string): boolean {
  const start = cue.startsWith("^");
  const end = cue.endsWith("$");
  const words = cue.slice(start ? 1 : 0, end ? -1 : undefined);
  const needle = ` ${words} `;
  if (start && end) return text === needle;
  if (start) return text.startsWith(needle);
  if (end) return text.endsWith(needle);
  return text.includes(needle);
}

/** Every cue of a scenario that occurs in the English, by moment. */
function cueHits(en: string, scenario: Scenario): Map<string, number> {
  const hits = new Map<string, number>();
  for (const [moment, cues] of Object.entries(SCENE_CUES[scenario]))
    for (const cue of cues) if (hasCue(en, cue)) hits.set(moment, (hits.get(moment) ?? 0) + 1);
  return hits;
}

/**
 * The scenario and moment a sentence belongs to, or null: the scenario with
 * the most cue hits (a matching Tatoeba tag counts two), ties going to the
 * earlier scenario in SCENARIOS; the moment with the most hits within it.
 */
export function tagScene(
  en: string,
  tags: readonly string[] = [],
): { scenario: Scenario; scene: string } | null {
  const text = cueText(en);
  let best: { scenario: Scenario; scene: string; score: number } | null = null;
  for (const scenario of SCENARIOS) {
    const hits = cueHits(text, scenario);
    const tagged = tags.some((t) => TAG_SCENE[t] === scenario);
    const score = [...hits.values()].reduce((a, b) => a + b, 0) + (tagged ? 2 : 0);
    if (!score || (best && score <= best.score)) continue;
    const moments = [...hits].sort((a, b) => b[1] - a[1]);
    const scene = moments[0]?.[0] ?? Object.keys(SCENE_CUES[scenario])[0];
    best = { scenario, scene, score };
  }
  return best && { scenario: best.scenario, scene: best.scene };
}

/**
 * How useful a sentence is to get by: a point per USEFUL pattern its English
 * matches, a point off per LESS_USEFUL one.
 */
export const usefulness = (en: string) => {
  const t = normEn(en).trim();
  const q = /\?\s*$/.test(en) ? `${t}?` : t;
  return USEFUL.filter((r) => r.test(q)).length - LESS_USEFUL.filter((r) => r.test(t)).length;
};

export const isNarrative = (en: string) => {
  const t = normEn(en).trim();
  return NARRATIVE.some((r) => r.test(t));
};

export const skipByTags = (tags: readonly string[]) =>
  tags.some((t) => SKIP_TAGS.includes(t) || t.startsWith(SKIP_TAG_PREFIX));

/**
 * The words of a sentence for ranking, lowercased. A chunk the vocabulary
 * knows whole stays whole ("aujourd'hui", "peut-être"); otherwise it splits
 * at apostrophes and hyphens, and an elided part before an apostrophe
 * ("j'", "l'") is left out: it is always a function word.
 */
export function rankWords(term: string, vocab: Pick<Vocab, "known">): string[] {
  const out: string[] = [];
  for (const chunk of term.toLowerCase().split(/[^\p{L}\p{M}'’-]+/u)) {
    const c = chunk.replace(/^['’-]+|['’-]+$/g, "");
    if (!c) continue;
    if (vocab.known(c)) {
      out.push(c);
      continue;
    }
    const last = c.split(/['’]/).pop()!;
    for (const p of last.split("-")) if (p) out.push(p);
  }
  return out;
}

/**
 * A proper name: a capitalised word inside a sentence (not after . ? ! …),
 * or a capitalised word the English has too ("Sami prit le bus." — "Sami got
 * on a bus.") and the frequency lists do not rank.
 */
export function hasName(term: string, en = "", vocab?: Pick<Vocab, "band">): boolean {
  const t = term.trim();
  if (/[^.?!…:«"\s]\s+\p{Lu}/u.test(t) || /[,;]\s*\p{Lu}/u.test(t)) return true;
  const caps = t.match(/\p{Lu}[\p{L}\p{M}]+/gu) ?? [];
  return caps.some(
    (w) =>
      new RegExp(`(^|[^\\p{L}])${w}($|[^\\p{L}])`, "u").test(en) && !vocab?.band(w.toLowerCase()),
  );
}

export type Picked = CuratedLine & {
  scenario: Scenario;
  band: number;
  useful: number;
};

/** Why a candidate is left out, or null when it is kept. */
export function rejectReason(lang: string, c: Candidate, vocab: Vocab): string | null {
  const rule = phraseRule(lang);
  const term = c.term.trim();
  if (phraseLength(lang, term) > rule.max) return "long";
  if (c.en.length > 60) return "long English";
  if (/[0-9]/.test(term)) return "digits";
  // Read aloud up to the first of these (lib/words/spoken.ts): one phrase per card.
  if (/[;/·]/.test(term)) return "list punctuation";
  if (skipByTags(c.tags)) return "tag";
  if (isOffensive(c.en) || isOffensive(term)) return "offensive";
  if (isNarrative(c.en)) return "narrative";
  if (hasName(term, c.en, vocab)) return "name";
  if (rankWords(term, vocab).some((w) => !vocab.known(w))) return "unknown word";
  if (usefulness(c.en) < 0) return "not useful";
  return null;
}

/** The band of a sentence: its rarest word's. */
export const sentenceBand = (term: string, vocab: Vocab) =>
  Math.max(1, ...rankWords(term, vocab).map((w) => vocab.band(w) ?? vocab.beyond));

const normTerm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();

/** Order: lower band, then more useful, then shorter, then written in the language. */
export const byEase = (a: Picked & { orig?: boolean }, b: Picked & { orig?: boolean }) =>
  a.band - b.band ||
  b.useful - a.useful ||
  a.term.length - b.term.length ||
  Number(!!b.orig) - Number(!!a.orig);

/**
 * The decks' sources: per scenario, its sentences easiest first, each with
 * its moment, register (from Tatoeba tags), Tatoeba id and author.
 */
export function pickSceneSentences(
  lang: string,
  candidates: readonly Candidate[],
  vocab: Vocab,
): { decks: Map<Scenario, CuratedLine[]>; rejected: Map<string, number> } {
  const rejected = new Map<string, number>();
  const kept: (Picked & { orig?: boolean })[] = [];
  for (const c of candidates) {
    const why = rejectReason(lang, c, vocab);
    const tag = why ? null : tagScene(c.en, c.tags);
    const reason = why ?? (tag ? null : "no scenario");
    if (reason) {
      rejected.set(reason, (rejected.get(reason) ?? 0) + 1);
      continue;
    }
    const register = c.tags.map((t) => TAG_REGISTER[t]).find(Boolean);
    kept.push({
      term: c.term.trim(),
      back: c.en.trim(),
      scene: tag!.scene,
      ...(register ? { register } : {}),
      src: `tatoeba:${c.id}`,
      by: c.by,
      ...(c.enId ? { enId: c.enId, ...(c.enBy ? { enBy: c.enBy } : {}) } : {}),
      auto: true,
      scenario: tag!.scenario,
      band: sentenceBand(c.term, vocab),
      useful: usefulness(c.en),
      orig: c.orig,
    });
  }
  kept.sort(byEase);
  const terms = new Set<string>();
  const backs = new Set<string>();
  const decks = new Map<Scenario, CuratedLine[]>();
  for (const p of kept) {
    const t = normTerm(p.term);
    const e = normTerm(p.back);
    if (terms.has(t) || backs.has(e)) {
      rejected.set("repeat", (rejected.get("repeat") ?? 0) + 1);
      continue;
    }
    terms.add(t);
    backs.add(e);
    const { scenario, band: _b, useful: _u, orig: _o, ...line } = p;
    if (!isScenario(scenario)) continue;
    const deck = decks.get(scenario) ?? [];
    if (!deck.length) decks.set(scenario, deck);
    deck.push(line);
  }
  return { decks, rejected };
}
