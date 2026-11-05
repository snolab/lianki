/**
 * Scenario phrase decks on /words: short everyday phrases ("お会計お願いします。")
 * grouped by situation (restaurant, transport…), one list per language and
 * scenario. They are word lists like the others (term → English back), with
 * a usage note, a register (casual / polite) and the moment they belong to.
 * Pure helpers, shared by the build (scripts/words/build-phrase-decks.ts),
 * the picker and the tests. Sources and checks: public/words/SOURCES.md.
 */
import { descendants, type FlatItem, type TreeNode } from "./tree";

/**
 * The scenarios, in the order the picker lists them: survival first (owner,
 * 2026-11-05 "目标是 survive" — what you need to get by when living or
 * travelling there), the rest of daily life after.
 */
export const SCENARIOS = [
  "emergency",
  "health",
  "transport",
  "restaurant",
  "shopping",
  "hotel",
  "admin",
  "greetings",
  "feelings",
  "help",
  "phone",
  "small-talk",
  "work",
  "school",
] as const;
export type Scenario = (typeof SCENARIOS)[number];
export const isScenario = (s: unknown): s is Scenario => SCENARIOS.includes(s as Scenario);

/** English names, for catalog names in index.json; the UI shows its own (words-phrases). */
export const SCENARIO_EN: Record<Scenario, string> = {
  greetings: "Greetings and introductions",
  "small-talk": "Small talk",
  restaurant: "Restaurant and café",
  shopping: "Shopping and paying",
  transport: "Transport and directions",
  hotel: "Hotel and travel",
  admin: "Paperwork, bank and services",
  work: "Work and office",
  school: "School and class",
  health: "Health and pharmacy",
  phone: "Phone, messaging and online",
  emergency: "Emergencies and police",
  feelings: "Feelings, thanks and apologies",
  help: "Asking for help, not understanding",
};

export const REGISTERS = ["casual", "polite"] as const;
export type Register = (typeof REGISTERS)[number];

/** One phrase card, as stored in `<lang>-phrases-<scenario>.json`. */
export type PhraseEntry = {
  term: string;
  /** ja: the phrase in kana; zh: pinyin with tone marks. */
  reading?: string;
  /** A natural English equivalent. */
  back: string;
  /** Who says it to whom, when: one short English line. */
  note?: string;
  register?: Register;
  /** The moment within the scenario ("ordering", "at check-in"). */
  scene?: string;
  /** `https://tatoeba.org/sentences/show/<id>` for a Tatoeba sentence, else "generated". */
  src: string;
};

export const GENERATED = "generated";
const TATOEBA = /^https:\/\/tatoeba\.org\/sentences\/show\/(\d+)$/;
export const tatoebaUrl = (id: string | number) => `https://tatoeba.org/sentences/show/${id}`;
/** The Tatoeba sentence id of a `src`, or null for a generated line. */
export const tatoebaId = (src: string) => TATOEBA.exec(src)?.[1] ?? null;

export const phraseListId = (lang: string, s: Scenario) => `${lang}-phrases-${s}`;

/**
 * What a language's phrases must look like, as data (no per-language code):
 * - `max`: longest phrase, short enough to say in one breath (≈ 8 words),
 *   counted in `unit`: characters for a language written without spaces,
 *   words otherwise;
 * - `scripts`: the Unicode scripts its letters may be in (Common and
 *   Inherited marks such as ー are always fine; LOANS are allowed as is);
 * - `need`: a letter of one of these scripts must appear;
 * - `reading`: what a `reading` may contain, when the language has one.
 */
export type PhraseLangRule = {
  max: number;
  unit: "char" | "word";
  scripts: readonly string[];
  need?: readonly string[];
  reading?: { pattern: RegExp; name: string };
};

/** Pinyin: Latin letters with tone marks, spaces and the punctuation phrases keep. */
const PINYIN = /^[a-zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜü' ，。？！,.?!]+$/;
/** Kana, with the marks and punctuation (Common) a reading keeps. */
const KANA_ONLY = /^[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Common}\s]+$/u;

export const PHRASE_LANG: Record<string, PhraseLangRule> = {
  ja: {
    max: 20,
    unit: "char",
    scripts: ["Hiragana", "Katakana", "Han"],
    need: ["Hiragana", "Katakana", "Han"],
    reading: { pattern: KANA_ONLY, name: "kana" },
  },
  zh: {
    max: 14,
    unit: "char",
    scripts: ["Han"],
    need: ["Han"],
    reading: { pattern: PINYIN, name: "pinyin" },
  },
  fr: { max: 8, unit: "word", scripts: ["Latin"], need: ["Latin"] },
};
/** Any other language: written in words, script unchecked. */
const DEFAULT_RULE: PhraseLangRule = { max: 8, unit: "word", scripts: [] };
export const phraseRule = (lang: string): PhraseLangRule => PHRASE_LANG[lang] ?? DEFAULT_RULE;

/** Words of a phrase, for the `word` length unit ("l'heure" is two). */
export const phraseWords = (term: string) =>
  term.split(/[\s'’]+/u).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
/** A phrase's length in its language's unit. */
export const phraseLength = (lang: string, term: string) =>
  phraseRule(lang).unit === "word" ? phraseWords(term) : [...term.trim()].length;

export const MAX_BACK = 60;
export const MAX_NOTE = 90;
export const MAX_SCENE = 40;

const DIGIT = /[0-9０-９]/;
/** Latin words that phrases write as is ("WiFi密码是多少？", "OKです"). */
const LOANS = /\b(WiFi|Wi-Fi|OK|APP|PPT|ID|LINE|AED|SMS)\b/g;
const scriptClass = (scripts: readonly string[]) => scripts.map((s) => `\\p{Script=${s}}`).join("");
/** A letter outside `scripts` (Common and Inherited letters are fine). */
const outside = (scripts: readonly string[]) =>
  new RegExp(`[^\\P{L}${scriptClass([...scripts, "Common", "Inherited"])}]`, "u");

/**
 * What is wrong with a phrase card, as short messages (none = fine): its
 * fields, its length, and its script (PHRASE_LANG: letters only in the
 * language's scripts, no digits, a reading in the language's reading script).
 */
export function phraseProblems(lang: string, e: PhraseEntry): string[] {
  const rule = phraseRule(lang);
  const out: string[] = [];
  const term = e.term?.trim() ?? "";
  if (!term) out.push("empty term");
  if (phraseLength(lang, term) > rule.max) out.push(`term over ${rule.max} ${rule.unit}s`);
  if (!e.back?.trim()) out.push("empty back");
  if ((e.back ?? "").length > MAX_BACK) out.push(`back over ${MAX_BACK} characters`);
  if ((e.note ?? "").length > MAX_NOTE) out.push(`note over ${MAX_NOTE} characters`);
  if ((e.scene ?? "").length > MAX_SCENE) out.push(`scene over ${MAX_SCENE} characters`);
  if (e.register !== undefined && !REGISTERS.includes(e.register))
    out.push(`register "${e.register}"`);
  if (e.src !== GENERATED && !TATOEBA.test(e.src ?? "")) out.push(`src "${e.src}"`);
  if (DIGIT.test(term)) out.push("digits in term");
  if (rule.scripts.length && outside(rule.scripts).test(term.replace(LOANS, "")))
    out.push(`letters outside ${rule.scripts.join("/")} in term`);
  if (rule.need?.length && !new RegExp(`[${scriptClass(rule.need)}]`, "u").test(term))
    out.push(`no ${rule.need.join("/")} letters in term`);
  if (e.reading && rule.reading && !rule.reading.pattern.test(e.reading.toLowerCase()))
    out.push(`reading not ${rule.reading.name}`);
  return out;
}

/** Catalog rows in index.json that are phrase decks. */
export type PhraseMeta = { kind?: string; scenario?: string };
export const isPhraseMeta = (c: PhraseMeta | null | undefined) => c?.kind === "phrase";

type Row = TreeNode & { lang: string; name: string };

/**
 * Where a newly added phrase deck goes in the learner's tree: inside the
 * language's "Phrases" group, which sits inside the language's own group
 * when there is one. `phrasesGroup` is a group of that language holding
 * only phrase decks (or an empty one with the Phrases name); null means it
 * has to be made, under `langGroup` (null = top level).
 */
export function phraseHome<T extends Row>(
  flat: FlatItem<T>[],
  lang: string,
  isGroup: (r: T) => boolean,
  isPhrase: (r: T) => boolean,
  phrasesLabel: string,
): { langGroup: string | null; phrasesGroup: string | null } {
  const byId = new Map(flat.map((r) => [r.id, r]));
  const holdsPhrases = (g: T) => {
    const kids = descendants(flat, g.id).map((id) => byId.get(id)!);
    return kids.length
      ? kids.every(isPhrase)
      : g.name.trim().toLowerCase() === phrasesLabel.trim().toLowerCase();
  };
  const groups = flat.filter((r) => isGroup(r) && r.lang === lang);
  const phrases = groups.find(holdsPhrases) ?? null;
  const langGroup = groups.find((g) => g !== phrases && !holdsPhrases(g)) ?? null;
  return { langGroup: langGroup?.id ?? null, phrasesGroup: phrases?.id ?? null };
}

/**
 * The whole tree's order with `id` (and its subtree) moved to be the last
 * child of `parentId` (null = the end of the top level), for PATCH
 * /api/words/lists.
 */
export function moveUnder<T extends TreeNode>(
  flat: FlatItem<T>[],
  id: string,
  parentId: string | null,
): { id: string; parentId: string | null }[] {
  const moving = new Set([id, ...descendants(flat, id)]);
  if (parentId && moving.has(parentId))
    return flat.map((r) => ({ id: r.id, parentId: r.parentId }));
  const rest = flat.filter((r) => !moving.has(r.id));
  const block = flat
    .filter((r) => moving.has(r.id))
    .map((r) => ({ id: r.id, parentId: r.id === id ? parentId : r.parentId }));
  let at = rest.length;
  if (parentId) {
    const p = rest.findIndex((r) => r.id === parentId);
    if (p >= 0) at = p + 1 + descendants(rest, parentId).length;
  }
  const out = rest.map((r) => ({ id: r.id, parentId: r.parentId }));
  out.splice(at, 0, ...block);
  return out;
}

/**
 * A phrase deck's row name in the picker, in the UI's language: just the
 * scenario inside its Phrases group, "Phrases · scenario" inside another
 * group of its language, and with the catalog's language name in front
 * elsewhere. A deck the learner renamed keeps its name (null).
 */
export function phraseRowName(
  list: { name: string; lang: string },
  catalogName: string,
  parent: { lang: string } | null | undefined,
  parentHoldsPhrases: boolean,
  labels: { phrases: string; scenario: string },
): string | null {
  if (list.name !== catalogName) return null;
  if (parent && parent.lang === list.lang)
    return parentHoldsPhrases ? labels.scenario : `${labels.phrases} · ${labels.scenario}`;
  const cut = catalogName.indexOf(" · ");
  const language = cut > 0 ? catalogName.slice(0, cut) : "";
  return [language, labels.phrases, labels.scenario].filter(Boolean).join(" · ");
}
