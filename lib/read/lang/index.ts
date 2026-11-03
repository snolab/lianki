// What /read knows about each language, as data (owner, 2026-11-03 19:05 JST:
// "你不要对任何语言有各种特殊处理" — no per-language branches in code). The text
// engine (lib/read/words.ts: Intl.Segmenter + Unicode normalisation) is the
// same for every language; a language's behaviour comes only from its file
// here, looked up by its primary subtag. A language without a file gets the
// defaults: no elisions, folds or abbreviations; capitals mark names
// wherever the script has case.
//
// Adding a language: write `<lang>.json` with any of the fields of LangData
// and list it in FILES. For a dictionary (form → lemma map and headwords),
// build public/words/lemma/<lang>.txt (scripts/words/build-lemmas.ts) and
// set "lemmas": true.

import ca from "./ca.json";
import de from "./de.json";
import en from "./en.json";
import es from "./es.json";
import fr from "./fr.json";
import it from "./it.json";
import ja from "./ja.json";
import ko from "./ko.json";
import pt from "./pt.json";
import ru from "./ru.json";
import und from "./und.json";
import zh from "./zh.json";

/** One language's data file. Every field is optional. */
export interface LangData {
  /** A few function words, to guess the language of text that names none. */
  stop?: string[];
  /**
   * A Unicode script (or several, `|`-separated, as in \p{Script=…}) that
   * marks text as this language when its tag is missing. Files are tried in
   * FILES order, so Japanese kana wins over Chinese Han.
   */
  script?: string;
  /** Clitics written before an apostrophe and dropped from the word: l' → "", qu' → "". */
  elisions?: string[];
  /** Endings dropped from a word: English possessive "'s". */
  suffixes?: string[];
  /** Ligatures and their written-out spelling, the key both spellings share: œ → oe. */
  ligatures?: [string, string][];
  /**
   * Cheap inflection folds, tried only when the folded form is itself a card
   * or an entry: [ending, replacement, unless the word ends in this].
   */
  folds?: ([string, string] | [string, string, string])[];
  /** Abbreviations whose full stop does not end a sentence (Mrs., M.), lowercase. */
  abbreviations?: string[];
  /** Capitalised mid-sentence words mark names (default true); false where every noun is capitalised. */
  names?: boolean;
  /** Word beginnings that are never names though capitalised (English I'm, I've). */
  notNames?: string[];
  /** A card's reading is a key too when it matches this pattern (Japanese kana). */
  readingKeys?: string;
  /** Has a lemma file, public/words/lemma/<lang>.txt (lib/read/lemma.ts). */
  lemmas?: boolean;
}

const FILES: [string, LangData][] = [
  ["en", en as LangData],
  ["fr", fr as LangData],
  ["es", es as LangData],
  ["de", de as LangData],
  ["it", it as LangData],
  ["pt", pt as LangData],
  ["ca", ca as LangData],
  ["ja", ja as LangData],
  ["ko", ko as LangData],
  ["zh", zh as LangData],
  ["ru", ru as LangData],
  ["und", und as LangData],
];

/** A language's data, compiled for the engine. */
export interface LangRules {
  data: LangData;
  /** The elision prefix of a lowercase word ("l'", "qu'"), or null. */
  elide: RegExp | null;
  /** The same, any case, for reading a word's own first letter ("l'Angleterre"). */
  elideAnyCase: RegExp | null;
  suffix: RegExp | null;
  abbreviations: ReadonlySet<string>;
  names: boolean;
  reading: RegExp | null;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function compile(data: LangData): LangRules {
  const el = data.elisions?.length ? `^(?:${data.elisions.map(esc).join("|")})'(?=\\p{L})` : null;
  return {
    data,
    elide: el ? new RegExp(el, "u") : null,
    elideAnyCase: el ? new RegExp(el, "iu") : null,
    suffix: data.suffixes?.length
      ? new RegExp(`(?:${data.suffixes.map(esc).join("|")})$`, "u")
      : null,
    abbreviations: new Set(data.abbreviations ?? []),
    names: data.names !== false,
    reading: data.readingKeys ? new RegExp(data.readingKeys, "u") : null,
  };
}

const RULES = new Map(FILES.map(([l, d]) => [l, compile(d)]));
const DEFAULT = compile({});

/** The rules for a language (its primary subtag); the defaults when it has no file. */
export function langRules(lang: string): LangRules {
  return RULES.get(lang) ?? DEFAULT;
}

/** Languages that can be guessed from their script, in order. */
export const SCRIPT_LANGS: [string, RegExp][] = FILES.filter(([, d]) => d.script).map(([l, d]) => [
  l,
  new RegExp(
    d
      .script!.split("|")
      .map((s) => `\\p{Script=${s}}`)
      .join("|"),
    "u",
  ),
]);

/** Languages with function words to guess from. */
export const STOP_LANGS: [string, string[]][] = FILES.filter(([, d]) => d.stop?.length).map(
  ([l, d]) => [l, d.stop!],
);
