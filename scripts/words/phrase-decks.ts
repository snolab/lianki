/**
 * Scenario phrase decks: the curated sources (scripts/words/phrases/*.jsonl)
 * → list files and index.json rows. Pure, so the tests run it on fixtures;
 * the CLI is build-phrase-decks.ts.
 */
import {
  GENERATED,
  SCENARIOS,
  SCENARIO_EN,
  phraseListId,
  phraseProblems,
  tatoebaId,
  tatoebaUrl,
  type PhraseEntry,
  type Scenario,
} from "@/lib/words/phrases";

/**
 * One curated line: `src` is "tatoeba:<id>" or "generated"; `by` is the
 * Tatoeba sentence's author, credited in SOURCES.md (not in the deck file).
 */
export type CuratedLine = Omit<PhraseEntry, "src"> & { src: string; by?: string };

export type PhraseListMeta = {
  id: string;
  lang: string;
  name: string;
  level: string;
  kind: "phrase";
  scenario: Scenario;
  count: number;
  file: string;
  source: string;
  license: string;
};

export const LANG_NAME: Record<string, string> = { ja: "Japanese", zh: "Chinese" };
export const PHRASE_SOURCE =
  "Phrases: Tatoeba (tatoeba.org) sentences written by native speakers, each linked in its src; lines marked generated were written for Lianki and checked for natural use";
export const PHRASE_LICENSE = "CC BY 2.0 FR (Tatoeba sentences)";

const normSrc = (src: string): string => {
  const m = /^tatoeba:(\d+)$/.exec(src.trim());
  if (m) return tatoebaUrl(m[1]);
  return src.trim();
};

/** Parse a .jsonl source (blank lines and `//` comments allowed). */
export function parseJsonl(text: string): CuratedLine[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//"))
    .map((l) => JSON.parse(l) as CuratedLine);
}

/** `lang\tterm` lines the owner marked drop in the review sheet. */
export function parseDrops(text: string): Set<string> {
  return new Set(
    text
      .split("\n")
      .map((l) => l.replace(/\r$/, ""))
      .filter((l) => l.trim() && !l.startsWith("#"))
      .map((l) => {
        const [lang, term] = l.split("\t");
        return `${lang?.trim()}\t${term?.trim()}`;
      }),
  );
}

export type Built = {
  files: { file: string; json: object }[];
  lists: PhraseListMeta[];
  problems: string[];
  /** Per deck, its Tatoeba sentences and their authors, for SOURCES.md. */
  credits: { id: string; sentences: { id: string; by?: string }[] }[];
};

/**
 * Build the decks of the given sources. A line with a problem
 * (phraseProblems), one the owner dropped, or a repeat of a phrase already
 * in an earlier scenario of the same language is left out; problems are
 * reported so the CLI can fail.
 */
export function buildPhraseDecks(
  sources: { lang: string; scenario: Scenario; lines: CuratedLine[] }[],
  drops: Set<string> = new Set(),
): Built {
  const files: Built["files"] = [];
  const lists: PhraseListMeta[] = [];
  const problems: string[] = [];
  const credits: Built["credits"] = [];
  const sorted = [...sources].sort(
    (a, b) =>
      a.lang.localeCompare(b.lang) || SCENARIOS.indexOf(a.scenario) - SCENARIOS.indexOf(b.scenario),
  );
  const seen = new Map<string, Set<string>>();
  for (const { lang, scenario, lines } of sorted) {
    const used = seen.get(lang) ?? new Set<string>();
    seen.set(lang, used);
    const entries: PhraseEntry[] = [];
    const sentences: { id: string; by?: string }[] = [];
    for (const line of lines) {
      const e: PhraseEntry = {
        term: line.term.trim(),
        ...(line.reading?.trim() ? { reading: line.reading.trim() } : {}),
        back: line.back.trim(),
        ...(line.note?.trim() ? { note: line.note.trim() } : {}),
        ...(line.register ? { register: line.register } : {}),
        ...(line.scene?.trim() ? { scene: line.scene.trim() } : {}),
        src: normSrc(line.src),
      };
      const bad = phraseProblems(lang, e);
      if (bad.length) {
        problems.push(`${lang}-${scenario}: ${e.term}: ${bad.join(", ")}`);
        continue;
      }
      if (drops.has(`${lang}\t${e.term}`) || used.has(e.term)) continue;
      used.add(e.term);
      entries.push(e);
      const tid = tatoebaId(e.src);
      if (tid) sentences.push({ id: tid, ...(line.by ? { by: line.by } : {}) });
    }
    if (!entries.length) continue;
    const id = phraseListId(lang, scenario);
    const meta = {
      id,
      lang,
      name: `${LANG_NAME[lang] ?? lang} · Phrases · ${SCENARIO_EN[scenario]}`,
      level: "Phrases",
      kind: "phrase" as const,
      scenario,
      source: PHRASE_SOURCE,
      license: PHRASE_LICENSE,
    };
    files.push({ file: `${id}.json`, json: { ...meta, entries } });
    credits.push({ id, sentences });
    lists.push({ ...meta, count: entries.length, file: `${id}.json` });
  }
  return { files, lists, problems, credits };
}

/**
 * index.json's rows with the phrase decks of `langs` replaced by `fresh`.
 * Word lists stay as they are; within a language, phrase decks come after
 * its word lists, in scenario order.
 */
export function mergeIndex<T extends { id: string; lang: string; kind?: string }>(
  existing: T[],
  fresh: PhraseListMeta[],
  langs: string[],
): (T | PhraseListMeta)[] {
  const kept = existing.filter((l) => !(l.kind === "phrase" && langs.includes(l.lang)));
  const out: (T | PhraseListMeta)[] = [];
  const langOrder = [...new Set([...kept.map((l) => l.lang), ...fresh.map((l) => l.lang)])];
  for (const lang of langOrder) {
    out.push(...kept.filter((l) => l.lang === lang && l.kind !== "phrase"));
    const phrases = [
      ...kept.filter((l) => l.lang === lang && l.kind === "phrase"),
      ...fresh.filter((l) => l.lang === lang),
    ] as (T | PhraseListMeta)[];
    const sc = (l: T | PhraseListMeta) =>
      SCENARIOS.indexOf((l as PhraseListMeta).scenario ?? ("" as Scenario));
    out.push(...phrases.sort((a, b) => sc(a) - sc(b)));
  }
  return out;
}

export const isGenerated = (e: { src: string }) => e.src === GENERATED;

export const CREDITS_START = "<!-- phrase-credits:start (build-phrase-decks.ts writes this) -->";
export const CREDITS_END = "<!-- phrase-credits:end -->";

/**
 * SOURCES.md with its per-sentence credits block rewritten: one line per
 * deck, each Tatoeba sentence linked by its id, with its author.
 */
export function withCredits(md: string, credits: Built["credits"]): string {
  const a = md.indexOf(CREDITS_START);
  const b = md.indexOf(CREDITS_END);
  if (a < 0 || b < a) return md;
  const lines = credits.map(
    (c) =>
      `- \`${c.id}\`: ` +
      (c.sentences.length
        ? c.sentences
            .map((s) => `[#${s.id}](${tatoebaUrl(s.id)})${s.by ? ` ${s.by}` : ""}`)
            .join(", ")
        : "no Tatoeba sentences"),
  );
  return `${md.slice(0, a + CREDITS_START.length)}\n\n${lines.join("\n")}\n\n${md.slice(b)}`;
}
